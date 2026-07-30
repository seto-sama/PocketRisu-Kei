import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import pkg from './index.cjs'

const {
    createBackupRestoreService,
    createLegacyRestoreService,
    restoreMissingAssetsFromBackupFile,
} = pkg as {
    createBackupRestoreService: (dependencies: Record<string, any>) => {
        importBackupFromSource: (
            source: AsyncIterable<Buffer>,
            options?: { totalBytes?: number },
        ) => Promise<{ assetsRestored: number; bytesReceived: number; coldStorageFailed: number }>
    }
    createLegacyRestoreService: (dependencies: Record<string, any>) => any
    restoreMissingAssetsFromBackupFile: (options: {
        db: any
        filePath: string
        missingBasenames: Set<string>
    }) => Promise<{
        referencedMissing: number
        assetsFound: number
        assetsUnavailable: number
        assetsRestored: number
        restoredBytes: number
        skippedExisting: number
    }>
}

function backupEntry(name: string, value: Buffer) {
    const nameBuffer = Buffer.from(name)
    const header = Buffer.alloc(8)
    header.writeUInt32LE(nameBuffer.length, 0)
    header.writeUInt32LE(value.length, 4)
    return Buffer.concat([header.subarray(0, 4), nameBuffer, header.subarray(4), value])
}

function freshDb() {
    const db = new Database(':memory:')
    db.exec(
        'CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)',
    )
    return db
}

describe('restoreMissingAssetsFromBackupFile', () => {
    it('returns immediately when the current database has no missing assets', async () => {
        const db = freshDb()
        await expect(restoreMissingAssetsFromBackupFile({
            db,
            filePath: '/path/that/does/not/need/to/exist',
            missingBasenames: new Set(),
        })).resolves.toEqual({
            referencedMissing: 0,
            assetsFound: 0,
            assetsUnavailable: 0,
            assetsRestored: 0,
            restoredBytes: 0,
            skippedExisting: 0,
        })
    })

    it('restores target assets only and never overwrites an existing row', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'pocketrisu-asset-restore-'))
        const missingValue = Buffer.from('missing asset')
        const missingName = `${createHash('sha256').update(missingValue).digest('hex')}.png`
        const existingValue = Buffer.from('newer current asset')
        const backupExistingValue = Buffer.from('older backup asset')
        const existingName = `${createHash('sha256').update(backupExistingValue).digest('hex')}.png`
        const unrelatedValue = Buffer.from('unrelated')
        const unrelatedName = `${createHash('sha256').update(unrelatedValue).digest('hex')}.png`
        const filePath = join(dir, 'risu-backup-1.bin')
        await writeFile(filePath, Buffer.concat([
            backupEntry(missingName, missingValue),
            backupEntry(existingName, backupExistingValue),
            backupEntry(unrelatedName, unrelatedValue),
            backupEntry('database.risudat', Buffer.from('database')),
        ]))

        const db = freshDb()
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 1)')
            .run(`assets/${existingName}`, existingValue)

        const result = await restoreMissingAssetsFromBackupFile({
            db,
            filePath,
            missingBasenames: new Set([missingName, existingName, 'not-in-backup.png']),
        })

        expect(result).toEqual({
            referencedMissing: 3,
            assetsFound: 2,
            assetsUnavailable: 1,
            assetsRestored: 1,
            restoredBytes: missingValue.length,
            skippedExisting: 1,
        })
        expect(db.prepare('SELECT value FROM kv WHERE key = ?').get(`assets/${missingName}`).value)
            .toEqual(missingValue)
        expect(db.prepare('SELECT value FROM kv WHERE key = ?').get(`assets/${existingName}`).value)
            .toEqual(existingValue)
        expect(db.prepare('SELECT value FROM kv WHERE key = ?').get(`assets/${unrelatedName}`))
            .toBeUndefined()
    })

    it('rejects a hash-mismatched target without writing any target', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'pocketrisu-asset-restore-'))
        const goodValue = Buffer.from('good')
        const goodName = `${createHash('sha256').update(goodValue).digest('hex')}.png`
        const badName = `${'0'.repeat(64)}.png`
        const filePath = join(dir, 'risu-backup-2.bin')
        await writeFile(filePath, Buffer.concat([
            backupEntry(goodName, goodValue),
            backupEntry(badName, Buffer.from('does not match')),
        ]))
        const db = freshDb()

        await expect(restoreMissingAssetsFromBackupFile({
            db,
            filePath,
            missingBasenames: new Set([goodName, badName]),
        })).rejects.toThrow('hash mismatch')
        expect(db.prepare('SELECT COUNT(*) count FROM kv').get().count).toBe(0)
    })

    it('rejects truncated framing before opening a write transaction', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'pocketrisu-asset-restore-'))
        const value = Buffer.from('complete asset')
        const name = `${createHash('sha256').update(value).digest('hex')}.png`
        const complete = backupEntry(name, value)
        const filePath = join(dir, 'risu-backup-3.bin')
        await writeFile(filePath, Buffer.concat([complete, Buffer.from([1, 2])]))
        const db = freshDb()

        await expect(restoreMissingAssetsFromBackupFile({
            db,
            filePath,
            missingBasenames: new Set([name]),
        })).rejects.toThrow('incomplete entry')
        expect(db.prepare('SELECT COUNT(*) count FROM kv').get().count).toBe(0)
    })
})

describe('createBackupRestoreService', () => {
    it('owns the full backup restore flow and replaces the old asset set', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pocketrisu-full-restore-'))
        const savePath = join(root, 'save')
        const inlayDir = join(savePath, 'inlays')
        await mkdir(savePath, { recursive: true })
        const db = freshDb()
        const set = db.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        const del = db.prepare('DELETE FROM kv WHERE key = ?')
        const get = db.prepare('SELECT value FROM kv WHERE key = ?')
        set.run('assets/old.png', Buffer.from('old'), 1)

        const service = createBackupRestoreService({
            savePath,
            inlayDir,
            inlayMigrationMarker: join(inlayDir, '.migrated_to_fs'),
            remoteMigrationMarkerKey: 'migration/disable-remote-saving',
            sqliteDb: db,
            kvGet: (key: string) => get.get(key)?.value ?? null,
            kvSet: (key: string, value: Buffer) => set.run(key, value, Date.now()),
            kvDel: (key: string) => del.run(key),
            kvDelPrefix: (prefix: string) =>
                db.prepare('DELETE FROM kv WHERE key LIKE ?').run(`${prefix}%`),
            clearEntities: () => {},
            checkpointWal: () => {},
            flushPendingDb: async () => {},
            createBackupAndRotate: () => {},
            invalidateDbCache: () => {},
            decodeDatabaseWithPersistentChatIds: async () => ({}),
            initChatStore: () => {},
            normalizeInlayExt: (ext: string) => ext || 'bin',
            isSafeInlayId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
            decodeDataUri: () => ({ buffer: Buffer.alloc(0) }),
            ensureInlayDir: () => mkdir(inlayDir, { recursive: true }),
            normalizeColdStorageStorageKey: (key: string) => key,
            parseColdStorageJsonBuffer: () => ({ coldData: {} }),
            encodeColdStorageCanonicalBuffer: () => Buffer.alloc(0),
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        })

        const newAsset = Buffer.from('new asset')
        const database = Buffer.from('database')
        const backup = Buffer.concat([
            backupEntry('new.png', newAsset),
            backupEntry('database.risudat', database),
        ])
        async function* chunks() {
            yield backup.subarray(0, 7)
            yield backup.subarray(7, 19)
            yield backup.subarray(19)
        }

        const result = await service.importBackupFromSource(chunks(), {
            totalBytes: backup.length,
        })

        expect(result).toEqual({
            assetsRestored: 1,
            bytesReceived: backup.length,
            coldStorageFailed: 0,
        })
        expect(get.get('assets/old.png')).toBeUndefined()
        expect(get.get('assets/new.png').value).toEqual(newAsset)
        expect(get.get('database/database.bin').value).toEqual(database)
    })
})

describe('createLegacyRestoreService', () => {
    it('accepts OriginalRisu underscore cold-storage names and restores characters', () => {
        const db = freshDb()
        const set = db.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        const get = db.prepare('SELECT value FROM kv WHERE key = ?')
        const service = createLegacyRestoreService({
            savePath: '/tmp',
            sqliteDb: db,
            kvGet: (key: string) => get.get(key)?.value ?? null,
            kvSet: (key: string, value: Buffer) => set.run(key, value, Date.now()),
            kvDel: (key: string) => db.prepare('DELETE FROM kv WHERE key = ?').run(key),
            kvDelPrefix: () => {},
            kvCopyValue: () => {},
            clearEntities: () => {},
            flushPendingDb: async () => {},
            createBackupAndRotate: () => {},
            invalidateDbCache: () => {},
            decodeRisuSave: async () => ({}),
            encodeRisuSaveLegacy: () => Buffer.alloc(0),
            hasRemoteBlocks: () => false,
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            setDbEtag: () => {},
        })
        const id = '12345678-1234-1234-1234-123456789abc'
        expect(service.normalizeColdStorageStorageKey(`coldstorage_${id}.json`))
            .toBe(`coldstorage/${id}`)

        const coldData = {
            character: {
                name: 'Restored',
                chaId: 'char-1',
                chats: [{ name: 'Recovered chat', message: [] }],
            },
        }
        set.run(
            `coldstorage/${id}`,
            service.encodeColdStorageCanonicalBuffer(coldData),
            1,
        )
        const database = {
            characters: [{
                name: 'Stub',
                chaId: 'char-1',
                coldstorage: id,
                coldStoragedChats: [],
                chats: [],
            }],
        }

        expect(service.restoreColdStorageCharactersInDb(database)).toEqual({
            restored: 1,
            failed: 0,
            failedNames: [],
        })
        expect(database.characters[0].name).toBe('Restored')
        expect(database.characters[0].coldstorage).toBeUndefined()
    })

    it('imports a legacy save-folder entry set and clears incompatible old data', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pocketrisu-legacy-restore-'))
        const db = freshDb()
        const set = db.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        const get = db.prepare('SELECT value FROM kv WHERE key = ?')
        const del = db.prepare('DELETE FROM kv WHERE key = ?')
        set.run('assets/old.png', Buffer.from('old'), 1)
        set.run('coldstorage/old', Buffer.from('old cold data'), 1)

        const service = createLegacyRestoreService({
            savePath: root,
            sqliteDb: db,
            kvGet: (key: string) => get.get(key)?.value ?? null,
            kvSet: (key: string, value: Buffer) => set.run(key, value, Date.now()),
            kvDel: (key: string) => del.run(key),
            kvDelPrefix: (prefix: string) =>
                db.prepare('DELETE FROM kv WHERE key LIKE ?').run(`${prefix}%`),
            kvCopyValue: () => {},
            clearEntities: () => {},
            flushPendingDb: async () => {},
            createBackupAndRotate: () => {},
            invalidateDbCache: () => {},
            decodeRisuSave: async () => ({}),
            encodeRisuSaveLegacy: () => Buffer.alloc(0),
            hasRemoteBlocks: () => false,
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            setDbEtag: () => {},
        })

        await expect(service.importHexEntries([
            { key: 'assets/new.png', value: Buffer.from('new') },
            { key: 'database/database.bin', value: Buffer.from('database') },
        ])).resolves.toEqual({ imported: 2 })

        expect(get.get('assets/old.png')).toBeUndefined()
        expect(get.get('coldstorage/old')).toBeUndefined()
        expect(get.get('assets/new.png').value).toEqual(Buffer.from('new'))
        expect(get.get('database/database.bin').value).toEqual(Buffer.from('database'))
        await expect(access(service.migrationMarkerPath)).resolves.toBeUndefined()
    })
})

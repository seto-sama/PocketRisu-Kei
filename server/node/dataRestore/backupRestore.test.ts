import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
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

const temporaryDirectories = new Set<string>()

async function makeTemporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix))
    temporaryDirectories.add(directory)
    return directory
}

afterEach(async () => {
    await Promise.all([...temporaryDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
    ))
    temporaryDirectories.clear()
})

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

async function fullRestoreHarness(
    prepareDatabaseProjection: (raw: Buffer, context: {
        getStagedValue(key: string): Buffer | null
    }) => Promise<{
        install(): unknown
        coldStorageFailed?: number
    }>,
) {
    const root = await makeTemporaryDirectory('pocketrisu-full-restore-')
    const savePath = join(root, 'save')
    const inlayDir = join(savePath, 'inlays')
    await mkdir(inlayDir, { recursive: true })
    const db = freshDb()
    db.exec(`
        CREATE TABLE canonical_projection (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            value TEXT NOT NULL
        );
        INSERT INTO canonical_projection(id, value) VALUES (1, 'old projection');
    `)
    const set = db.prepare(
        'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    const del = db.prepare('DELETE FROM kv WHERE key = ?')
    const get = db.prepare('SELECT value FROM kv WHERE key = ?')
    set.run('assets/old.png', Buffer.from('old'), 1)
    set.run('database/database.bin', Buffer.from('old compatibility blob'), 1)

    const service = createBackupRestoreService({
        savePath,
        inlayDir,
        inlayMigrationMarker: join(inlayDir, '.migrated_to_fs'),
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
        prepareDatabaseProjection,
        normalizeInlayExt: (ext: string) => ext || 'bin',
        isSafeInlayId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
        decodeDataUri: () => ({ buffer: Buffer.alloc(0) }),
        ensureInlayDir: () => mkdir(inlayDir, { recursive: true }),
        normalizeColdStorageStorageKey: (key: string) => key,
        parseColdStorageJsonBuffer: () => ({ coldData: {} }),
        encodeColdStorageCanonicalBuffer: () => Buffer.alloc(0),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    return { db, get, inlayDir, savePath, service }
}

function legacyRestoreDependencies(
    db: Database.Database,
    savePath: string,
    overrides: Record<string, any> = {},
) {
    const get = db.prepare('SELECT value FROM kv WHERE key = ?')
    const set = db.prepare(
        'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    const del = db.prepare('DELETE FROM kv WHERE key = ?')
    return {
        savePath,
        sqliteDb: db,
        kvGet: (key: string) => get.get(key)?.value ?? null,
        kvSet: (key: string, value: Buffer) => set.run(key, value, Date.now()),
        kvDel: (key: string) => del.run(key),
        kvDelPrefix: (prefix: string) =>
            db.prepare('DELETE FROM kv WHERE key LIKE ?').run(`${prefix}%`),
        clearEntities: () => {},
        flushPendingDb: async () => {},
        createBackupAndRotate: () => {},
        invalidateDbCache: () => {},
        prepareDatabaseProjection: async () => ({ install: () => {} }),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        ...overrides,
    }
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
        const dir = await makeTemporaryDirectory('pocketrisu-asset-restore-')
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
        const dir = await makeTemporaryDirectory('pocketrisu-asset-restore-')
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
        const dir = await makeTemporaryDirectory('pocketrisu-asset-restore-')
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
        const newAsset = Buffer.from('new asset')
        const database = Buffer.from('database')
        let preparedRaw: Buffer | null = null
        let stagedAssetSeen: Buffer | null = null
        let liveAssetSeenDuringInstall: Buffer | null = null
        let db!: ReturnType<typeof freshDb>
        let get!: any
        const harness = await fullRestoreHarness(async (raw, context) => {
            preparedRaw = Buffer.from(raw)
            stagedAssetSeen = context.getStagedValue('assets/new.png')
            return {
                install() {
                    liveAssetSeenDuringInstall = get.get('assets/new.png')?.value ?? null
                    db.prepare('UPDATE canonical_projection SET value = ? WHERE id = 1')
                        .run('new projection')
                    return { coldStorageFailed: 0 }
                },
            }
        })
        ;({ db, get } = harness)
        const backup = Buffer.concat([
            backupEntry('new.png', newAsset),
            backupEntry('database.risudat', database),
        ])
        async function* chunks() {
            yield backup.subarray(0, 7)
            yield backup.subarray(7, 19)
            yield backup.subarray(19)
        }

        const result = await harness.service.importBackupFromSource(chunks(), {
            totalBytes: backup.length,
        })

        expect(result).toEqual({
            assetsRestored: 1,
            bytesReceived: backup.length,
            coldStorageFailed: 0,
        })
        expect(preparedRaw).toEqual(database)
        expect(stagedAssetSeen).toEqual(newAsset)
        expect(liveAssetSeenDuringInstall).toEqual(newAsset)
        expect(get.get('assets/old.png')).toBeUndefined()
        expect(get.get('assets/new.png').value).toEqual(newAsset)
        expect(get.get('database/database.bin')).toBeUndefined()
        expect(db.prepare('SELECT value FROM canonical_projection WHERE id = 1').get().value)
            .toBe('new projection')
    })

    it('rolls back KV, canonical rows, and promoted inlays when install fails', async () => {
        let db!: ReturnType<typeof freshDb>
        const harness = await fullRestoreHarness(async () => ({
            install() {
                db.prepare('UPDATE canonical_projection SET value = ? WHERE id = 1')
                    .run('partially installed')
                throw new Error('projection install failed')
            },
        }))
        db = harness.db
        await writeFile(join(harness.inlayDir, 'old.png'), Buffer.from('old inlay'))
        const backup = Buffer.concat([
            backupEntry('new.png', Buffer.from('new asset')),
            backupEntry('inlay/new.png', Buffer.from('new inlay')),
            backupEntry('database.risudat', Buffer.from('database')),
        ])

        async function* chunks() { yield backup }
        await expect(harness.service.importBackupFromSource(chunks()))
            .rejects.toThrow('projection install failed')

        expect(harness.get.get('assets/old.png').value).toEqual(Buffer.from('old'))
        expect(harness.get.get('assets/new.png')).toBeUndefined()
        expect(harness.get.get('database/database.bin').value)
            .toEqual(Buffer.from('old compatibility blob'))
        expect(db.prepare('SELECT value FROM canonical_projection WHERE id = 1').get().value)
            .toBe('old projection')
        await expect(access(join(harness.inlayDir, 'old.png'))).resolves.toBeUndefined()
        await expect(access(join(harness.inlayDir, 'new.png'))).rejects.toThrow()
    })

    it.each([
        ['missing database', Buffer.alloc(0), 'does not contain database.risudat'],
        [
            'truncated trailing entry',
            Buffer.concat([
                backupEntry('database.risudat', Buffer.from('database')),
                Buffer.from([5, 0, 0]),
            ]),
            'incomplete entry',
        ],
    ])('keeps live state intact after 5001 staged entries with %s', async (
        _label,
        ending,
        expectedError,
    ) => {
        let prepareCalls = 0
        const harness = await fullRestoreHarness(async () => {
            prepareCalls += 1
            return { install: () => {} }
        })
        const manyEntries = Array.from({ length: 5001 }, (_, index) =>
            backupEntry(`asset-${index}.bin`, Buffer.from([index % 251])),
        )
        const backup = Buffer.concat([...manyEntries, ending])

        async function* chunks() { yield backup }
        await expect(harness.service.importBackupFromSource(chunks()))
            .rejects.toThrow(expectedError)

        expect(prepareCalls).toBe(0)
        expect(harness.db.prepare('SELECT key, value FROM kv ORDER BY key').all())
            .toEqual([
                {
                    key: 'assets/old.png',
                    value: Buffer.from('old'),
                },
                {
                    key: 'database/database.bin',
                    value: Buffer.from('old compatibility blob'),
                },
            ])
        expect(harness.db.prepare('SELECT value FROM canonical_projection WHERE id = 1').get().value)
            .toBe('old projection')
        expect((await readdir(harness.savePath)).filter(name =>
            name.startsWith('backup_restore_stage'),
        )).toEqual([])
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
            clearEntities: () => {},
            flushPendingDb: async () => {},
            createBackupAndRotate: () => {},
            invalidateDbCache: () => {},
            prepareDatabaseProjection: async () => ({ install: () => {} }),
            logger: { info: () => {}, warn: () => {}, error: () => {} },
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

    it('stages a save folder and exposes its REMOTE entries to projection preparation', async () => {
        const root = await makeTemporaryDirectory('pocketrisu-legacy-folder-')
        const sourceDirectory = join(root, 'source')
        await mkdir(sourceDirectory)
        const db = freshDb()
        db.exec('CREATE TABLE canonical_projection (payload BLOB NOT NULL)')
        const database = Buffer.from('folder database')
        const remote = Buffer.from('folder remote')
        await writeFile(
            join(sourceDirectory, Buffer.from('database/database.bin').toString('hex')),
            database,
        )
        await writeFile(
            join(sourceDirectory, Buffer.from('remotes/block.local.bin').toString('hex')),
            remote,
        )
        let preparedSource: any

        const service = createLegacyRestoreService(legacyRestoreDependencies(db, root, {
            prepareDatabaseProjection: async (raw: Buffer, { source }: any) => {
                expect(raw).toEqual(database)
                expect(source.getEntry('remotes/block.local.bin')).toEqual(remote)
                preparedSource = source
                return {
                    install: () => db.prepare(
                        'INSERT INTO canonical_projection (payload) VALUES (?)',
                    ).run(raw),
                }
            },
        }))

        await expect(service.importHexFilesFromDir(sourceDirectory))
            .resolves.toEqual({ imported: 2 })
        expect(preparedSource.kind).toBe('save-folder')
        expect(preparedSource.location).toBe(sourceDirectory)
        expect(db.prepare('SELECT value FROM kv WHERE key = ?')
            .get('remotes/block.local.bin').value).toEqual(remote)
        expect(db.prepare('SELECT value FROM kv WHERE key = ?')
            .get('database/database.bin')).toBeUndefined()
        expect(db.prepare('SELECT payload FROM canonical_projection').get().payload)
            .toEqual(database)
    })

    it('imports a staged hex-entry set and clears incompatible old data', async () => {
        const root = await makeTemporaryDirectory('pocketrisu-legacy-restore-')
        const db = freshDb()
        const set = db.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        const get = db.prepare('SELECT value FROM kv WHERE key = ?')
        const del = db.prepare('DELETE FROM kv WHERE key = ?')
        db.exec('CREATE TABLE canonical_projection (payload BLOB NOT NULL)')
        set.run('assets/old.png', Buffer.from('old'), 1)
        set.run('coldstorage/old', Buffer.from('old cold data'), 1)

        let preparedSource: any

        const service = createLegacyRestoreService({
            savePath: root,
            sqliteDb: db,
            kvGet: (key: string) => get.get(key)?.value ?? null,
            kvSet: (key: string, value: Buffer) => set.run(key, value, Date.now()),
            kvDel: (key: string) => del.run(key),
            kvDelPrefix: (prefix: string) =>
                db.prepare('DELETE FROM kv WHERE key LIKE ?').run(`${prefix}%`),
            clearEntities: () => {},
            flushPendingDb: async () => {},
            createBackupAndRotate: () => {},
            invalidateDbCache: () => {},
            prepareDatabaseProjection: async (raw: Buffer, { source }: any) => {
                // Preparation/decoding happens while the current KV data is
                // still intact and can resolve only explicitly staged entries.
                expect(get.get('assets/old.png').value).toEqual(Buffer.from('old'))
                expect(raw).toEqual(Buffer.from('database'))
                expect(source.getEntry('remotes/block.local.bin'))
                    .toEqual(Buffer.from('remote block'))
                expect(source.getEntry('assets/not-staged.png')).toBeNull()
                preparedSource = source
                return {
                    install: () => db.prepare(
                        'INSERT INTO canonical_projection (payload) VALUES (?)',
                    ).run(raw),
                }
            },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        })

        await expect(service.importHexEntries([
            { key: 'assets/new.png', value: Buffer.from('new') },
            { key: 'remotes/block.local.bin', value: Buffer.from('remote block') },
            { key: 'database/database.bin', value: Buffer.from('database') },
        ])).resolves.toEqual({ imported: 3 })

        expect(preparedSource.kind).toBe('hex-entries')
        expect(get.get('assets/old.png')).toBeUndefined()
        expect(get.get('coldstorage/old')).toBeUndefined()
        expect(get.get('assets/new.png').value).toEqual(Buffer.from('new'))
        expect(get.get('remotes/block.local.bin').value).toEqual(Buffer.from('remote block'))
        expect(get.get('database/database.bin')).toBeUndefined()
        expect(db.prepare('SELECT payload FROM canonical_projection').get().payload)
            .toEqual(Buffer.from('database'))
        await expect(access(service.migrationMarkerPath)).resolves.toBeUndefined()
    })

    it('leaves current KV and relational data untouched when projection preparation fails', async () => {
        const root = await makeTemporaryDirectory('pocketrisu-legacy-invalid-')
        const db = freshDb()
        db.exec('CREATE TABLE canonical_projection (payload TEXT NOT NULL)')
        db.prepare('INSERT INTO canonical_projection (payload) VALUES (?)').run('current')
        const set = db.prepare(
            'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        set.run('assets/current.png', Buffer.from('current asset'), 1)
        set.run('database/database.bin', Buffer.from('stale legacy blob'), 1)
        let backups = 0
        let invalidations = 0

        const service = createLegacyRestoreService(legacyRestoreDependencies(db, root, {
            createBackupAndRotate: () => { backups++ },
            invalidateDbCache: () => { invalidations++ },
            prepareDatabaseProjection: async () => {
                expect(db.prepare('SELECT value FROM kv WHERE key = ?')
                    .get('assets/current.png').value).toEqual(Buffer.from('current asset'))
                throw new Error('invalid database projection')
            },
        }))

        await expect(service.importHexEntries([
            { key: 'assets/new.png', value: Buffer.from('new asset') },
            { key: 'database/database.bin', value: Buffer.from('invalid') },
        ])).rejects.toThrow('invalid database projection')

        expect(db.prepare('SELECT value FROM kv WHERE key = ?')
            .get('assets/current.png').value).toEqual(Buffer.from('current asset'))
        expect(db.prepare('SELECT value FROM kv WHERE key = ?')
            .get('database/database.bin').value).toEqual(Buffer.from('stale legacy blob'))
        expect(db.prepare('SELECT value FROM kv WHERE key = ?').get('assets/new.png'))
            .toBeUndefined()
        expect(db.prepare('SELECT payload FROM canonical_projection').get().payload)
            .toBe('current')
        expect(backups).toBe(0)
        expect(invalidations).toBe(0)
    })

    it('rolls back asset replacement and the projection together when install fails', async () => {
        const root = await makeTemporaryDirectory('pocketrisu-legacy-atomic-')
        const db = freshDb()
        db.exec('CREATE TABLE canonical_projection (payload TEXT NOT NULL)')
        db.prepare('INSERT INTO canonical_projection (payload) VALUES (?)').run('current')
        const set = db.prepare(
            'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        set.run('assets/current.png', Buffer.from('current asset'), 1)
        set.run('database/database.bin', Buffer.from('stale legacy blob'), 1)

        const service = createLegacyRestoreService(legacyRestoreDependencies(db, root, {
            prepareDatabaseProjection: async () => ({
                install: () => {
                    db.prepare('UPDATE canonical_projection SET payload = ?').run('incoming')
                    throw new Error('projection install failed')
                },
            }),
        }))

        await expect(service.importHexEntries([
            { key: 'assets/new.png', value: Buffer.from('new asset') },
            { key: 'database/database.bin', value: Buffer.from('incoming') },
        ])).rejects.toThrow('projection install failed')

        expect(db.prepare('SELECT value FROM kv WHERE key = ?')
            .get('assets/current.png').value).toEqual(Buffer.from('current asset'))
        expect(db.prepare('SELECT value FROM kv WHERE key = ?')
            .get('database/database.bin').value).toEqual(Buffer.from('stale legacy blob'))
        expect(db.prepare('SELECT value FROM kv WHERE key = ?').get('assets/new.png'))
            .toBeUndefined()
        expect(db.prepare('SELECT payload FROM canonical_projection').get().payload)
            .toBe('current')
    })

})

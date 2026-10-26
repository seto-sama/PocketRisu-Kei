import { createHash, createCipheriv } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encode as encodeMessagePack } from 'msgpackr'
import Database from '../sqlite.cjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pkg from './index.cjs'
import { encodeBackupEntry as backupEntry, encodeRisuSaveBlocks } from '../../test/compat/helpers/encode'

const {
    createBackupRestoreService,
    createLegacyRestoreService,
    restoreMissingAssetsFromBackupFile,
} = pkg as {
    createBackupRestoreService: (dependencies: Record<string, any>) => {
        importBackupFromSource: (
            source: AsyncIterable<Buffer>,
            options?: { totalBytes?: number },
        ) => Promise<{ assetsRestored: number; bytesReceived: number; coldStorageFailed: number; pluginStorageColdFailed: number; skippedSaveBlocks: string[] }>
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
    vi.unstubAllGlobals()
    await Promise.all([...temporaryDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
    ))
    temporaryDirectories.clear()
})

function pluginStorageBackupEntry(namespace: string, key: string, value: Buffer, owner?: string) {
    const encodedKey = Buffer.from(key, 'utf-8').toString('base64url')
    return backupEntry(
        `plugin-storage/${namespace}/${encodedKey}`,
        encodeMessagePack({ value, ...(owner ? { owner } : {}) }),
    )
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
        pluginStorageColdFailed?: number
        discardedStorageKeys?: Set<string>
    }>,
    overrides: Record<string, any> = {},
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
    const logger = { info: () => {}, warn: () => {}, error: () => {} }
    const coldStorage = createLegacyRestoreService({
        sqliteDb: db,
        kvGet: (key: string) => get.get(key)?.value ?? null,
        kvSet: (key: string, value: Buffer) => set.run(key, value, Date.now()),
        kvDel: (key: string) => del.run(key),
        logger,
    })

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
        createBackupAndRotate: () => {},
        invalidateDbCache: () => {},
        prepareDatabaseProjection,
        normalizeInlayExt: (ext: string) => ext || 'bin',
        isSafeInlayId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
        decodeDataUri: () => ({ buffer: Buffer.alloc(0) }),
        ensureInlayDir: () => mkdir(inlayDir, { recursive: true }),
        normalizeColdStorageStorageKey: coldStorage.normalizeColdStorageStorageKey,
        normalizeColdStorageBackupBuffer: coldStorage.normalizeColdStorageBackupBuffer,
        logger,
        ...overrides,
    })
    return { db, get, inlayDir, savePath, service, coldStorage }
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
    it('applies plugin storage snapshots present in the backup, including empty snapshots', async () => {
        const restoredPluginStorage: Array<Array<{ namespace: string; key: string; value: Buffer; owner?: string }>> = []
        const harness = await fullRestoreHarness(async () => ({ install() {} }), {
            replacePluginStorage: (entries: Iterable<any>) => {
                restoredPluginStorage.push([...entries])
            },
        })
        const manifest = backupEntry('plugin-storage/_manifest', Buffer.from(JSON.stringify({
            version: 1,
            namespaces: ['localStorage', 'localForage'],
        })))
        const backup = Buffer.concat([
            manifest,
            pluginStorageBackupEntry('localStorage', 'plugin/a:設定', Buffer.from([0, 255, 12]), 'plugin-a'),
            pluginStorageBackupEntry('localForage', '', Buffer.from('opaque-localforage-bytes')),
            backupEntry('database.risudat', Buffer.from('database')),
        ])

        async function* chunks(value: Buffer) { yield value }
        await harness.service.importBackupFromSource(chunks(backup))
        expect(restoredPluginStorage[0]).toEqual([
            {
                namespace: 'localStorage',
                key: 'plugin/a:設定',
                value: Buffer.from([0, 255, 12]),
                owner: 'plugin-a',
            },
            {
                namespace: 'localForage',
                key: '',
                value: Buffer.from('opaque-localforage-bytes'),
            },
        ])

        const emptySnapshot = Buffer.concat([
            manifest,
            backupEntry('database.risudat', Buffer.from('database')),
        ])
        await harness.service.importBackupFromSource(chunks(emptySnapshot))
        expect(restoredPluginStorage[1]).toEqual([])

        await harness.service.importBackupFromSource(chunks(
            backupEntry('database.risudat', Buffer.from('database')),
        ))
        expect(restoredPluginStorage).toHaveLength(2)

        const incompleteSnapshot = Buffer.concat([
            backupEntry('plugin-storage/_manifest', Buffer.from(JSON.stringify({
                version: 1,
                namespaces: ['localStorage'],
            }))),
            backupEntry('database.risudat', Buffer.from('database')),
        ])
        await expect(harness.service.importBackupFromSource(chunks(incompleteSnapshot)))
            .rejects.toThrow('Unsupported plugin storage backup manifest')

        const unmarkedEntry = Buffer.concat([
            pluginStorageBackupEntry('localStorage', 'new-key', Buffer.from('value')),
            backupEntry('database.risudat', Buffer.from('database')),
        ])
        await expect(harness.service.importBackupFromSource(chunks(unmarkedEntry)))
            .rejects.toThrow('Plugin storage backup entries require a manifest')
        expect(restoredPluginStorage).toHaveLength(2)
    })

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
            pluginStorageColdFailed: 0,
            skippedSaveBlocks: [],
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

    it.each(['before', 'after'])('skips signature inlays with metadata %s their raw backup entries', async order => {
        const media = Buffer.from('image data')
        const harness = await fullRestoreHarness(async () => ({ install() {} }), {
            decodeDataUri: (data: string) => ({ buffer: Buffer.from(data.split(',')[1], 'base64') }),
        })
        const metadata = [
            backupEntry('inlay_sidecar/raw', Buffer.from(JSON.stringify({ type: 'signature', ext: 'json' }))),
            backupEntry('inlay_info/legacy', Buffer.from(JSON.stringify({ type: 'signature', ext: 'json' }))),
        ]
        const raw = [
            backupEntry('inlay/raw.json', Buffer.from('opaque signature')),
            backupEntry('inlay/legacy.json', Buffer.from('opaque signature')),
        ]
        const backup = Buffer.concat([
            ...(order === 'before' ? metadata : raw),
            backupEntry('inlay/unsupported', Buffer.from(JSON.stringify({
                type: 'signature', ext: 'json', data: 'opaque signature',
            }))),
            backupEntry('inlay/image', Buffer.from(JSON.stringify({
                type: 'image', ext: 'png', data: `data:image/png;base64,${media.toString('base64')}`,
            }))),
            ...(order === 'before' ? raw : metadata),
            backupEntry('database.risudat', Buffer.from('database')),
        ])
        async function* chunks() { yield backup }
        try {
            expect(await harness.service.importBackupFromSource(chunks())).toMatchObject({ assetsRestored: 1 })
            expect(await readFile(join(harness.inlayDir, 'image.png'))).toEqual(media)
            for (const id of ['unsupported', 'raw', 'legacy']) {
                await expect(access(join(harness.inlayDir, `${id}.json`))).rejects.toThrow()
                await expect(access(join(harness.inlayDir, `${id}.meta.json`))).rejects.toThrow()
            }
        } finally { harness.db.close() }
    })

    it('restores staged plugin, character, and chat data and discards plugin cold originals and failures', async () => {
        const pluginColdId = 'plugin-cold-id'
        const missingColdId = 'plugin-missing-id'
        const corruptColdId = 'plugin-corrupt-id'
        const characterColdId = 'character-cold-id'
        const chatColdId = 'chat-cold-id'
        const corruptColdValue = Buffer.from('unreadable cold storage')
        const database = {
            pluginCustomStorage: {
                _coldplugin: {
                    'memory/state': pluginColdId,
                    'memory/restored': 'plugin-restored-id',
                    'memory/missing': missingColdId,
                    'memory/corrupt': corruptColdId,
                },
                'memory/state': 'new inline value',
                'other/value': 'kept inline',
            },
            characters: [{
                chaId: 'character-1',
                coldstorage: characterColdId,
                chats: [],
            }],
        }
        let harness!: Awaited<ReturnType<typeof fullRestoreHarness>>
        harness = await fullRestoreHarness(async (_raw, context) => {
            const coldRestoreResult = harness.coldStorage.restoreColdStorageInDb(database, context)
            expect(harness.get.get(`coldstorage/${pluginColdId}`)).toBeUndefined()
            return {
                coldStorageFailed: coldRestoreResult.characters.failed,
                pluginStorageColdFailed: coldRestoreResult.pluginStorage.failed,
                discardedStorageKeys: coldRestoreResult.pluginStorage.discardedStorageKeys,
                install() {},
            }
        })
        const backup = Buffer.concat([
            backupEntry(`coldstorage/${pluginColdId}.json`, Buffer.from(JSON.stringify({ entries: [1, 2] }))),
            backupEntry('coldstorage/plugin-restored-id.json', Buffer.from(JSON.stringify({ entries: [3] }))),
            backupEntry(`coldstorage/${corruptColdId}.json`, corruptColdValue),
            backupEntry(`coldstorage/${characterColdId}.json`, Buffer.from(JSON.stringify({
                character: {
                    name: 'Restored character',
                    chats: [{
                        id: 'chat-1',
                        message: [{ data: `\uEF01COLDSTORAGE\uEF01${chatColdId}` }],
                    }],
                },
            }))),
            backupEntry(`coldstorage/${chatColdId}.json`, Buffer.from(JSON.stringify({
                message: [{ data: 'restored chat body' }],
                localLore: ['restored lore'],
            }))),
            backupEntry('database.risudat', Buffer.from('database')),
        ])

        async function* chunks() { yield backup }
        const result = await harness.service.importBackupFromSource(chunks())

        expect(result.coldStorageFailed).toBe(0)
        expect(result.pluginStorageColdFailed).toBe(2)
        expect(database.pluginCustomStorage).toEqual({
            'memory/state': 'new inline value',
            'memory/restored': { entries: [3] },
            'other/value': 'kept inline',
        })
        expect(database.characters[0]).toMatchObject({
            name: 'Restored character',
            chats: [{
                id: 'chat-1',
                message: [{ data: 'restored chat body' }],
                localLore: ['restored lore'],
            }],
        })
        expect(harness.db.prepare("SELECT key FROM kv WHERE key LIKE 'coldstorage/%' ORDER BY key").all())
            .toEqual([{ key: `coldstorage/${characterColdId}` }, { key: `coldstorage/${chatColdId}` }])
    })

    it('imports RisuAI plugin blocks into canonical storage without reading old server cold data', async () => {
        const { createAppDataStore } = require('../appDataStore.cjs')
        const { decodeRisuSave } = require('../utils/risuSave.cjs')
        const largeValue = { text: 'sidecar value' }
        const database = {
            characters: [],
            pluginCustomStorage: {
                same: 'new inline value',
                _coldpluginIndex: 'index-id',
                _coldplugin: { same: 'shadowed-id', legacy: 'legacy-id', missing: 'legacy-stale-id' },
            },
        }
        const expected = {
            same: 'new inline value', small: { enabled: true }, zero: 0,
            flag: false, empty: '', nil: null, large: largeValue, legacy: 'legacy value',
        }
        let harness!: Awaited<ReturnType<typeof fullRestoreHarness>>
        let store: any
        harness = await fullRestoreHarness(async (raw, context) => {
            const decoded = await decodeRisuSave(raw)
            const result = harness.coldStorage.restoreColdStorageInDb(decoded, context)
            expect(store.exportProjection().pluginCustomStorage).toEqual({ existing: 'replaced by backup' })
            return {
                pluginStorageColdFailed: result.pluginStorage.failed,
                coldStorageFailed: result.characters.failed,
                discardedStorageKeys: result.pluginStorage.discardedStorageKeys,
                install: () => store.replaceFromProjection(decoded),
            }
        })
        store = createAppDataStore(harness.db)
        store.replaceFromProjection({ characters: [], pluginCustomStorage: { existing: 'replaced by backup' } })
        harness.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
            .run('coldstorage/missing-id', harness.coldStorage.encodeColdStorageCanonicalBuffer('old server value'))
        const index = {
            type: 'risu-plugin-storage-index', version: 1,
            entries: [
                { k: 'same', s: 'invalid shadowed JSON' },
                { k: 'small', s: '"superseded entry"' },
                { k: 'small', s: '{"enabled":true}' },
                { k: 'zero', s: '0' }, { k: 'flag', s: 'false' },
                { k: 'empty', s: '""' }, { k: 'nil', s: 'null' },
                { k: 'large', l: 'large-id', s: '"ignored inline JSON"' },
                { k: 'missing', l: 'missing-id' }, { k: 'corrupt', s: 'not JSON' },
            ],
            trash: [{ id: 'trash-id', at: 0 }],
        }
        const originalSave = encodeRisuSaveBlocks([
            { type: 1, name: 'root', data: Buffer.from(JSON.stringify({ characters: [] })) },
            { type: 11, name: 'pluginStorage', data: Buffer.from(JSON.stringify(database.pluginCustomStorage)) },
        ])
        const backup = Buffer.concat([
            backupEntry('database.risudat', originalSave),
            backupEntry('coldstorage_index-id.json', Buffer.from(JSON.stringify(index))),
            backupEntry('coldstorage_large-id.json', Buffer.from(JSON.stringify(largeValue))),
            backupEntry('coldstorage_legacy-id.json', Buffer.from(JSON.stringify('legacy value'))),
            backupEntry('coldstorage_legacy-stale-id.json', Buffer.from(JSON.stringify('stale fallback'))),
            backupEntry('coldstorage_trash-id.json', Buffer.from(JSON.stringify('deleted value'))),
        ])
        async function* chunks() { yield backup }
        try {
            expect(await harness.service.importBackupFromSource(chunks())).toMatchObject({
                coldStorageFailed: 0, pluginStorageColdFailed: 2,
            })
            expect(harness.db.prepare("SELECT key FROM kv WHERE key LIKE 'coldstorage/%'").all()).toEqual([])
            const stored = store.exportProjection().pluginCustomStorage
            expect(stored).toEqual(expected)
        } finally { harness.db.close() }
    })

    it('rolls back database, cold storage, assets, and inlays when installation fails', async () => {
        const coldId = 'plugin-cold-id'
        let harness!: Awaited<ReturnType<typeof fullRestoreHarness>>
        harness = await fullRestoreHarness(async (_raw, context) => {
            const result = harness.coldStorage.restoreColdStorageInDb({
                pluginCustomStorage: { _coldplugin: { 'memory/state': coldId } },
            }, context)
            return {
                discardedStorageKeys: result.pluginStorage.discardedStorageKeys,
                install() {
                    harness.db.prepare('UPDATE canonical_projection SET value = ? WHERE id = 1')
                        .run('partially installed')
                    throw new Error('projection install failed')
                },
            }
        })
        const oldColdValue = harness.coldStorage.encodeColdStorageCanonicalBuffer({ old: true })
        harness.db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 1)')
            .run('coldstorage/old-cold-id', oldColdValue)
        await writeFile(join(harness.inlayDir, 'old.png'), Buffer.from('old inlay'))
        async function* chunks() {
            yield backupEntry('new.png', Buffer.from('new asset'))
            yield backupEntry('inlay/new.png', Buffer.from('new inlay'))
            yield backupEntry(`coldstorage/${coldId}.json`, Buffer.from(JSON.stringify({ new: true })))
            yield backupEntry('database.risudat', Buffer.from('database'))
        }
        try {
            await expect(harness.service.importBackupFromSource(chunks())).rejects.toThrow('projection install failed')
            expect(harness.get.get('assets/old.png').value).toEqual(Buffer.from('old'))
            expect(harness.get.get('assets/new.png')).toBeUndefined()
            expect(harness.get.get('database/database.bin').value).toEqual(Buffer.from('old compatibility blob'))
            expect(harness.get.get('coldstorage/old-cold-id').value).toEqual(oldColdValue)
            expect(harness.get.get(`coldstorage/${coldId}`)).toBeUndefined()
            expect(harness.db.prepare('SELECT value FROM canonical_projection WHERE id = 1').get().value).toBe('old projection')
            expect(await readFile(join(harness.inlayDir, 'old.png'))).toEqual(Buffer.from('old inlay'))
            await expect(access(join(harness.inlayDir, 'new.png'))).rejects.toThrow()
        } finally { harness.db.close() }
    })

    it.each([
        ['missing database', Buffer.alloc(0), 'does not contain database.risudat'],
        ['Windows inlay path', backupEntry('inlay/..\\outside.png', Buffer.from('image')), 'Invalid inlay backup entry name'],
        [
            'truncated trailing entry',
            Buffer.concat([
                backupEntry('database.risudat', Buffer.from('database')),
                Buffer.from([5, 0, 0]),
            ]),
            'incomplete entry',
        ],
    ])('rejects invalid backups without changing live data: %s', async (
        _label,
        ending,
        expectedError,
    ) => {
        const harness = await fullRestoreHarness(async () => ({ install() {} }))
        const entries = Array.from({ length: 3 }, (_, index) =>
            backupEntry(`asset-${index}.bin`, Buffer.from([index % 251])),
        )
        const backup = Buffer.concat([...entries, ending])

        async function* chunks() { yield backup }
        await expect(harness.service.importBackupFromSource(chunks()))
            .rejects.toThrow(expectedError)

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
    it('discards an unsupported plugin index while restoring independent legacy values', () => {
        const service = createLegacyRestoreService({ logger: { error() {} } })
        const staged = new Map([
            ['coldstorage/index', service.encodeColdStorageCanonicalBuffer({
                type: 'risu-plugin-storage-index', version: 2, entries: [], trash: [],
            })],
            ['coldstorage/legacy', service.encodeColdStorageCanonicalBuffer(false)],
        ])
        const database = {
            pluginCustomStorage: {
                existing: 'kept', _coldpluginIndex: 'index', _coldplugin: { legacy: 'legacy' },
            },
        }
        const result = service.restoreColdStorageInDb(database, {
            getStagedValue: (key: string) => staged.get(key) ?? null,
        })

        expect(result.pluginStorage.failed).toBe(1)
        expect(database).toEqual({ pluginCustomStorage: { existing: 'kept', legacy: false } })
    })

    it('accepts RisuAI underscore cold-storage names and restores characters', () => {
        const db = freshDb()
        const set = db.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        const get = db.prepare('SELECT value FROM kv WHERE key = ?')
        const service = createLegacyRestoreService({
            sqliteDb: db,
            kvGet: (key: string) => get.get(key)?.value ?? null,
            kvSet: (key: string, value: Buffer) => set.run(key, value, Date.now()),
            kvDel: (key: string) => db.prepare('DELETE FROM kv WHERE key = ?').run(key),
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

        service.restoreColdStorageInDb(database)
        expect(database.characters[0].name).toBe('Restored')
        expect(database.characters[0].coldstorage).toBeUndefined()
    })

})

function encryptedAccountDatabase(plaintext: Buffer, key: string) {
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), Buffer.alloc(12))
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}
const accountMarker = backupEntry('encryption.risudat', Buffer.from(JSON.stringify({ type: 'account', time: 1788710000000 })))

describe('encrypted account backup restore', () => {
    it.each([true, false])('decrypts before projection validation, marker first: %s', async markerFirst => {
        const { encodeRisuSave, decodeRisuSave } = require('../utils/risuSave.cjs')
        const plaintext = Buffer.from(await encodeRisuSave({ characters: [], language: 'ko' }))
        const key = 'fixture-account-key'
        const harness = await fullRestoreHarness(async raw => {
            expect(raw).toEqual(plaintext)
            expect(await decodeRisuSave(raw)).toMatchObject({ characters: [], language: 'ko' })
            return { install: () => {} }
        })
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ key })))
        const databaseEntry = backupEntry('database.risudat', encryptedAccountDatabase(plaintext, key))
        const buffer = Buffer.concat([
            backupEntry('image.png', Buffer.from('asset')),
            ...(markerFirst ? [accountMarker, databaseEntry] : [databaseEntry, accountMarker]),
        ])
        async function* chunks() { for (let offset = 0; offset < buffer.length; offset += 7) yield buffer.subarray(offset, offset + 7) }
        try {
            expect(await harness.service.importBackupFromSource(chunks())).toMatchObject({ assetsRestored: 1 })
            expect(harness.get.get('assets/encryption.risudat')).toBeUndefined()
            expect(harness.get.get('assets/image.png').value).toEqual(Buffer.from('asset'))
        } finally { harness.db.close() }
    })
})

// @vitest-environment node
import crypto from 'node:crypto'
import Database from './sqlite.cjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import appDataMigrationPkg from './appDataMigration.cjs'
import appDataStorePkg from './appDataStore.cjs'

const {
    AppDataMigrationCleanupError,
    AppDataMigrationVerificationError,
    LEGACY_DATABASE_KEY,
    createAppDataMigration,
    semanticProjectionHash,
} = appDataMigrationPkg as any
const { createAppDataStore } = appDataStorePkg as any

const openDatabases: Database.Database[] = []

function sampleDatabase(label = 'legacy') {
    return {
        characters: [{
            chaId: 'character-1',
            name: label,
            chats: [{
                id: 'chat-1',
                name: 'chat',
                message: [
                    { chatId: 'message-1', role: 'user', data: '' },
                    { chatId: 'message-2', role: 'char', data: label },
                ],
            }],
        }],
        language: 'ko',
        enabled: false,
        future: { nested: [null, 0, ''] },
    }
}

function createHarness(options: { source?: unknown } = {}) {
    const sqlite = new Database(':memory:')
    openDatabases.push(sqlite)
    sqlite.exec(`
      CREATE TABLE legacy_kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      )
    `)
    const get = sqlite.prepare('SELECT value FROM legacy_kv WHERE key = ?')
    const set = sqlite.prepare(`
      INSERT OR REPLACE INTO legacy_kv (key, value) VALUES (?, ?)
    `)
    const del = sqlite.prepare('DELETE FROM legacy_kv WHERE key = ?')
    const kv = {
        get(key: string) {
            return (get.get(key) as { value: Buffer } | undefined)?.value
        },
        delete(key: string) {
            del.run(key)
        },
        set(key: string, value: Buffer) {
            set.run(key, value)
        },
    }
    if (options.source !== undefined) {
        kv.set(LEGACY_DATABASE_KEY, Buffer.from(JSON.stringify(options.source)))
    }
    const appDataStore = createAppDataStore(sqlite)
    const decodeLegacyBlob = vi.fn(async (bytes: Uint8Array) => (
        JSON.parse(Buffer.from(bytes).toString('utf8'))
    ))
    const normalizeProjection = (value: unknown) => JSON.parse(JSON.stringify(value))

    return {
        sqlite,
        kv,
        appDataStore,
        decodeLegacyBlob,
        normalizeProjection,
        migration(overrides: Record<string, unknown> = {}) {
            return createAppDataMigration({
                db: sqlite,
                appDataStore,
                kv,
                decodeLegacyBlob,
                normalizeProjection,
                now: () => 1_700_000_000_000,
                ...overrides,
            })
        },
    }
}

afterEach(() => {
    while (openDatabases.length > 0) openDatabases.pop()?.close()
})

describe('legacy database migration barrier', () => {
    it('installs and verifies the full projection before marking and removing the blob', async () => {
        const source = sampleDatabase()
        const harness = createHarness({ source })
        const events: string[] = []
        const originalDelete = harness.kv.delete
        harness.kv.delete = (key: string) => {
            events.push('delete')
            expect(harness.appDataStore.exportProjection()).toEqual(source)
            const markerCount = harness.sqlite.prepare(`
              SELECT COUNT(*) AS count FROM app_data_migrations
            `).get() as { count: number }
            expect(markerCount.count).toBe(1)
            originalDelete(key)
        }

        const migration = harness.migration()
        const result = await migration.run()

        expect(result).toMatchObject({
            status: 'migrated',
            revision: 1,
            legacyBlobRemoved: true,
            marker: {
                disposition: 'legacy-import',
                sourceHash: crypto.createHash('sha256')
                    .update(JSON.stringify(source))
                    .digest('hex'),
                projectionHash: semanticProjectionHash(source),
                completedAt: 1_700_000_000_000,
            },
        })
        expect(events).toEqual(['delete'])
        expect(harness.kv.get(LEGACY_DATABASE_KEY)).toBeUndefined()
        expect(harness.appDataStore.exportProjection()).toEqual(source)
        expect(harness.sqlite.pragma('foreign_key_check')).toEqual([])
    })

    it('rolls back relational rows and the marker when semantic verification fails', async () => {
        const source = sampleDatabase()
        const harness = createHarness({ source })
        const realStore = harness.appDataStore
        const deleteSpy = vi.spyOn(harness.kv, 'delete')
        const mismatchingStore = {
            ...realStore,
            exportProjection() {
                return { ...realStore.exportProjection(), language: 'mismatch' }
            },
        }
        const migration = harness.migration({ appDataStore: mismatchingStore })

        await expect(migration.run()).rejects.toBeInstanceOf(
            AppDataMigrationVerificationError,
        )

        expect(realStore.getState()).toMatchObject({ initialized: false, revision: 0 })
        expect(realStore.exportProjection()).toEqual({ characters: [] })
        expect(harness.sqlite.prepare(`
          SELECT COUNT(*) AS count FROM app_data_migrations
        `).get()).toEqual({ count: 0 })
        expect(harness.kv.get(LEGACY_DATABASE_KEY)).toBeInstanceOf(Buffer)
        expect(deleteSpy).not.toHaveBeenCalled()
    })

    it('keeps a committed canonical store when cleanup fails and retries cleanup idempotently', async () => {
        const source = sampleDatabase('canonical')
        const harness = createHarness({ source })
        const deleteFailure = new Error('simulated storage failure')
        const failingDelete = vi.fn(() => {
            throw deleteFailure
        })
        const firstMigration = harness.migration({
            kv: { get: harness.kv.get, delete: failingDelete },
        })

        let cleanupError: any
        try {
            await firstMigration.run()
        } catch (error) {
            cleanupError = error
        }
        expect(cleanupError).toBeInstanceOf(AppDataMigrationCleanupError)
        expect(cleanupError.cause).toBe(deleteFailure)
        expect(cleanupError.migrationResult).toMatchObject({
            status: 'migrated',
            legacyBlobRemoved: false,
        })
        expect(harness.appDataStore.exportProjection()).toEqual(source)
        expect(firstMigration.getMarker()).toMatchObject({
            disposition: 'legacy-import',
        })
        expect(harness.kv.get(LEGACY_DATABASE_KEY)).toBeInstanceOf(Buffer)

        // A stale writer leaves a different blob after cutover. Marker + rows
        // are authoritative, so the next run must not decode or import it.
        harness.kv.set(
            LEGACY_DATABASE_KEY,
            Buffer.from(JSON.stringify(sampleDatabase('stale overwrite'))),
        )
        harness.decodeLegacyBlob.mockClear()
        const secondResult = await harness.migration().run()

        expect(secondResult).toMatchObject({
            status: 'already-migrated',
            revision: 1,
            legacyBlobRemoved: true,
        })
        expect(harness.decodeLegacyBlob).not.toHaveBeenCalled()
        expect(harness.appDataStore.exportProjection()).toEqual(source)
        expect(harness.kv.get(LEGACY_DATABASE_KEY)).toBeUndefined()
    })

    it('preserves pre-existing canonical rows instead of importing a stale unmarked blob', async () => {
        const harness = createHarness({ source: sampleDatabase('stale') })
        const canonical = sampleDatabase('new relational write')
        harness.appDataStore.replaceFromProjection(canonical)

        const result = await harness.migration().run()

        expect(result).toMatchObject({
            status: 'canonical-kept',
            revision: 1,
            legacyBlobRemoved: true,
            marker: { disposition: 'canonical-kept' },
        })
        expect(harness.decodeLegacyBlob).not.toHaveBeenCalled()
        expect(harness.appDataStore.exportProjection()).toEqual(canonical)
        expect(harness.kv.get(LEGACY_DATABASE_KEY)).toBeUndefined()
    })

    it('detects a source rewrite during async decoding without installing partial rows', async () => {
        const source = sampleDatabase('first')
        const harness = createHarness({ source })
        const decodeLegacyBlob = vi.fn(async (bytes: Uint8Array) => {
            harness.kv.set(
                LEGACY_DATABASE_KEY,
                Buffer.from(JSON.stringify(sampleDatabase('changed'))),
            )
            return JSON.parse(Buffer.from(bytes).toString('utf8'))
        })
        const migration = harness.migration({ decodeLegacyBlob })

        await expect(migration.run()).rejects.toMatchObject({
            code: 'APP_DATA_MIGRATION_SOURCE_CHANGED',
        })

        expect(harness.appDataStore.getState()).toMatchObject({
            initialized: false,
            revision: 0,
        })
        expect(migration.getMarker()).toBeUndefined()
        expect(JSON.parse(
            harness.kv.get(LEGACY_DATABASE_KEY)!.toString('utf8'),
        ).characters[0].name).toBe('changed')
    })

    it('marks a relational-only database and reports an empty installation as no-source', async () => {
        const canonicalHarness = createHarness()
        canonicalHarness.appDataStore.replaceFromProjection(sampleDatabase('canonical'))

        const canonicalResult = await canonicalHarness.migration().run()
        expect(canonicalResult).toMatchObject({
            status: 'canonical-kept',
            legacyBlobRemoved: false,
            marker: {
                disposition: 'canonical-existing',
                sourceHash: null,
            },
        })

        const emptyHarness = createHarness()
        await expect(emptyHarness.migration().run()).resolves.toMatchObject({
            status: 'no-source',
            revision: 0,
            legacyBlobRemoved: false,
        })
    })
})

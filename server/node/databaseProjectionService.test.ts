// @vitest-environment node
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import appDataStorePkg from './appDataStore.cjs'
import projectionServicePkg from './databaseProjectionService.cjs'
import utilsPkg from './utils.cjs'

const { createAppDataStore } = appDataStorePkg as any
const {
    DatabaseProjectionApplyError,
    DatabaseProjectionConflictError,
    DatabaseProjectionValidationError,
    createDatabaseProjectionService,
} = projectionServicePkg as any
const { calculateHash } = utilsPkg as any

const openDatabases: Database.Database[] = []

function createStore() {
    const sqlite = new Database(':memory:')
    openDatabases.push(sqlite)
    const store = createAppDataStore(sqlite)
    return { sqlite, store }
}

function createService(options: Record<string, unknown> = {}) {
    const { sqlite, store } = createStore()
    return {
        sqlite,
        store,
        service: createDatabaseProjectionService({ appDataStore: store, ...options }),
    }
}

function sampleDatabase() {
    return {
        characters: [{
            chaId: 'character-1',
            name: '해적 리수',
            lastInteraction: 123,
            chats: [{
                id: 'chat-1',
                name: '첫 채팅',
                message: [{ chatId: 'message-1', role: 'user', data: '본문' }],
            }],
        }],
        language: 'ko',
        statics: { messages: 7, imports: 2, clientValue: 'kept' },
        localOnlyRoot: { secret: true },
    }
}

function expectedHash(value: unknown) {
    return calculateHash(value).toString(16)
}

function thrownBy(callback: () => unknown) {
    try {
        callback()
    } catch (error) {
        return error as any
    }
    throw new Error('Expected callback to throw')
}

afterEach(() => {
    while (openDatabases.length > 0) openDatabases.pop()?.close()
})

describe('database projection reads and initialization', () => {
    it('returns null for a pristine store so clients use conditional initialization', () => {
        const { service } = createService()

        expect(service.getStartupProjection()).toMatchObject({
            database: null,
            revision: 0,
            initialized: false,
        })
    })

    it('returns the app store startup projection with revision and etag', () => {
        const { store, service } = createService()
        store.replaceFromProjection(sampleDatabase())

        const result = service.getStartupProjection()

        expect(result).toMatchObject({
            etag: store.projectionEtag({ includeMessages: false }),
            revision: 1,
            initialized: true,
        })
        expect(result.database.characters[0].chats[0]).toEqual({
            id: 'chat-1',
            name: '첫 채팅',
            _stub: true,
        })
        expect(result.database.characters[0].chats[0]).not.toHaveProperty('message')
    })

    it('exports the startup projection only once per read', () => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        const exportProjection = vi.spyOn(store, 'exportProjection')
        const service = createDatabaseProjectionService({ appDataStore: store })

        const result = service.getStartupProjection()

        expect(result.database.characters[0].chats[0]).not.toHaveProperty('message')
        expect(exportProjection).toHaveBeenCalledTimes(1)
    })

    it('allows exactly one conditional initialization', () => {
        const { store, service } = createService()

        const initialized = service.initializeDatabase({
            characters: [],
            language: 'ko',
        }, { expectedRevision: 0 })

        expect(initialized).toMatchObject({ success: true, changed: true, revision: 1 })
        expect(store.exportProjection()).toEqual({ characters: [], language: 'ko' })

        const error = thrownBy(() => service.initializeDatabase({
            characters: [],
            language: 'en',
        }, { expectedRevision: 1 }))
        expect(error).toBeInstanceOf(DatabaseProjectionConflictError)
        expect(error).toMatchObject({
            statusCode: 409,
            code: 'DATABASE_ALREADY_INITIALIZED',
            currentRevision: 1,
            currentEtag: store.projectionEtag({ includeMessages: false }),
        })
        expect(store.exportProjection().language).toBe('ko')
    })

    it('preserves hydrated chat bodies during first-run initialization', () => {
        const { store, service } = createService()
        const database = sampleDatabase()

        const initialized = service.initializeDatabase(database, {
            expectedRevision: 0,
        })

        expect(initialized).toMatchObject({ success: true, revision: 1 })
        expect(store.getChat('character-1', 'chat-1').message).toEqual([
            { chatId: 'message-1', role: 'user', data: '본문' },
        ])
        expect(store.exportProjection()).toEqual(database)
    })

    it('rejects invalid initialization revisions with a typed validation error', () => {
        const { service } = createService()

        const error = thrownBy(() => service.initializeDatabase(
            { characters: [] },
            { expectedRevision: -1 },
        ))

        expect(error).toBeInstanceOf(DatabaseProjectionValidationError)
        expect(error).toMatchObject({ statusCode: 400 })
    })
})

describe('database projection JSON Patch commits', () => {
    it('commits against the visible hash without replacing chat bodies', () => {
        const { store, service } = createService()
        store.replaceFromProjection(sampleDatabase())
        const startup = service.getStartupProjection()

        const result = service.patchDatabase({
            expectedHash: expectedHash(startup.database),
            patch: [{ op: 'replace', path: '/language', value: 'en' }],
        })

        expect(result).toMatchObject({
            success: true,
            changed: true,
            appliedOperations: 1,
            revision: 2,
            etag: store.projectionEtag({ includeMessages: false }),
        })
        expect(store.exportProjection().language).toBe('en')
        expect(store.getChat('character-1', 'chat-1').message).toEqual([
            { chatId: 'message-1', role: 'user', data: '본문' },
        ])
    })

    it('uses the patch result document for root replacement operations', () => {
        const { store, service } = createService()
        store.replaceFromProjection(sampleDatabase())
        const startup = service.getStartupProjection()

        service.patchDatabase({
            expectedHash: expectedHash(startup.database),
            patch: [{
                op: 'replace',
                path: '',
                value: { characters: [], language: 'en' },
            }],
        })

        expect(store.exportProjection()).toEqual({ characters: [], language: 'en' })
    })

    it('treats an empty patch as a no-op even when its hash is stale', () => {
        const { sqlite, store, service } = createService()
        store.replaceFromProjection(sampleDatabase())
        const before = store.getState()
        const beforeChanges = (sqlite.prepare(
            'SELECT total_changes() AS count',
        ).get() as any).count

        const result = service.patchDatabase({
            expectedHash: 'definitely-stale',
            patch: [],
        })

        expect(result).toMatchObject({
            success: true,
            changed: false,
            appliedOperations: 0,
            revision: before.revision,
            etag: store.projectionEtag({ includeMessages: false }),
        })
        expect(store.getState()).toEqual(before)
        expect((sqlite.prepare('SELECT total_changes() AS count').get() as any).count)
            .toBe(beforeChanges)
    })

    it('reports the current revision, etag, and hash on stale input', () => {
        const { store, service } = createService()
        store.replaceFromProjection(sampleDatabase())

        const error = thrownBy(() => service.patchDatabase({
            expectedHash: 'stale',
            patch: [{ op: 'replace', path: '/language', value: 'en' }],
        }))

        expect(error).toBeInstanceOf(DatabaseProjectionConflictError)
        expect(error).toMatchObject({
            statusCode: 409,
            code: 'DATABASE_HASH_MISMATCH',
            currentRevision: 1,
            currentEtag: store.projectionEtag({ includeMessages: false }),
            currentHash: expectedHash(service.getStartupProjection().database),
        })
        expect(store.exportProjection().language).toBe('ko')
    })

    it('wraps invalid JSON Patch operations without modifying storage', () => {
        const { store, service } = createService()
        store.replaceFromProjection(sampleDatabase())
        const startup = service.getStartupProjection()

        const error = thrownBy(() => service.patchDatabase({
            expectedHash: expectedHash(startup.database),
            patch: [{ op: 'replace', path: '/missing', value: true }],
        }))

        expect(error).toBeInstanceOf(DatabaseProjectionApplyError)
        expect(error).toMatchObject({
            statusCode: 400,
            code: 'DATABASE_PATCH_APPLY_FAILED',
        })
        expect(error.cause).toBeTruthy()
        expect(store.exportProjection()).toEqual(sampleDatabase())
    })

    it('rejects malformed requests with typed validation errors', () => {
        const { service } = createService()

        expect(thrownBy(() => service.patchDatabase({
            patch: {},
            expectedHash: 'abc',
        }))).toBeInstanceOf(DatabaseProjectionValidationError)
        expect(thrownBy(() => service.patchDatabase({
            patch: [],
        }))).toBeInstanceOf(DatabaseProjectionValidationError)
    })

    it('turns a storage CAS race into a projection conflict with fresh metadata', () => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        let raced = false
        const racingStore = {
            ...store,
            syncStartupProjection(incoming: unknown, options: Record<string, unknown>) {
                if (!raced) {
                    raced = true
                    const concurrent = store.exportProjection({ includeMessages: false })
                    concurrent.language = 'ja'
                    store.syncStartupProjection(concurrent, {
                        expectedEtag: options.expectedEtag,
                    })
                }
                return store.syncStartupProjection(incoming, options)
            },
        }
        const service = createDatabaseProjectionService({ appDataStore: racingStore })
        const startup = service.getStartupProjection()

        const error = thrownBy(() => service.patchDatabase({
            expectedHash: expectedHash(startup.database),
            patch: [{ op: 'replace', path: '/language', value: 'en' }],
        }))

        expect(error).toBeInstanceOf(DatabaseProjectionConflictError)
        expect(error).toMatchObject({
            statusCode: 409,
            code: 'DATABASE_PROJECTION_CHANGED',
            currentRevision: 2,
            currentEtag: store.projectionEtag({ includeMessages: false }),
        })
        expect(store.exportProjection().language).toBe('ja')
    })
})

describe('remote and server-owned projection transforms', () => {
    it('hashes the filtered view, merges hidden data, and restores server metadata', () => {
        const filterRemoteProjection = vi.fn((database: any) => {
            const visible = structuredClone(database)
            delete visible.localOnlyRoot
            return visible
        })
        const mergeRemoteProjection = vi.fn((canonical: any, incoming: any) => ({
            ...incoming,
            localOnlyRoot: canonical.localOnlyRoot,
        }))
        const restoreServerOwnedMetadata = vi.fn((incoming: any, canonical: any) => {
            const restored = structuredClone(incoming)
            restored.statics.messages = canonical.statics.messages
            restored.characters[0].lastInteraction = canonical.characters[0].lastInteraction
            return restored
        })
        const { store, service } = createService({
            filterRemoteProjection,
            mergeRemoteProjection,
            restoreServerOwnedMetadata,
        })
        store.replaceFromProjection(sampleDatabase())
        const startup = service.getStartupProjection({ remote: true })

        expect(startup.database).not.toHaveProperty('localOnlyRoot')
        const result = service.patchDatabase({
            expectedHash: expectedHash(startup.database),
            patch: [
                { op: 'replace', path: '/language', value: 'en' },
                { op: 'replace', path: '/statics/messages', value: 999 },
                {
                    op: 'replace',
                    path: '/characters/0/lastInteraction',
                    value: 999,
                },
            ],
        }, { remote: true })

        expect(result).toMatchObject({ success: true, appliedOperations: 3, revision: 2 })
        expect(store.exportProjection()).toMatchObject({
            language: 'en',
            statics: { messages: 7, imports: 2, clientValue: 'kept' },
            localOnlyRoot: { secret: true },
        })
        expect(store.exportProjection().characters[0].lastInteraction).toBe(123)
        expect(store.getChat('character-1', 'chat-1').message[0].data).toBe('본문')
        expect(filterRemoteProjection).toHaveBeenCalled()
        expect(mergeRemoteProjection).toHaveBeenCalledOnce()
        expect(restoreServerOwnedMetadata).toHaveBeenCalledOnce()
    })
})

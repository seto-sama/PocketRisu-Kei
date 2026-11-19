// @vitest-environment node
import { openDatabase } from './sqlite.cjs'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import appDataStorePkg from './appDataStore.cjs'
import projectionServicePkg from './databaseProjectionService.cjs'
import { createDelta } from '../shared/guardedDelta.mjs'
import privacyGuardFilterPkg from './privacyGuardFilter.cjs'

const { createAppDataStore } = appDataStorePkg as any
const {
    DatabaseProjectionConflictError,
    DatabaseProjectionValidationError,
    createDatabaseProjectionService,
} = projectionServicePkg as any
const { filterHiddenFolders, guardHiddenDelta } = privacyGuardFilterPkg as any

const openDatabases: DatabaseSync[] = []

function createStore() {
    const sqlite = openDatabase(':memory:')
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

function languageDelta(database: any, language: string) {
    return { changes: createDelta(database, { ...database, language }) }
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
            etag: store.getState().projectionEtag,
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

    it('filters selected plugin storage for the session and preserves it across patches', () => {
        const { store, service } = createService()
        store.replaceFromProjection({
            ...sampleDatabase(),
            pluginCustomStorage: {
                memory: { entries: [1, 2, 3] },
                shared: 'kept',
            },
            plugins: [{ name: 'memory-v3', version: '3.0' }],
            pluginStorageMeta: {
                memory: { plugin: 'memory-v3', updatedAt: 1 },
            },
        })
        const options = { excludedPluginNames: ['memory-v3'] }
        const startup = service.getStartupProjection(options)

        expect(startup.database.pluginCustomStorage).toEqual({ shared: 'kept' })
        expect(startup.database.pluginStorageMeta).toEqual({})

        service.patchDatabase(languageDelta(startup.database, 'en'), options)

        expect(store.exportProjection({ includeMessages: false })).toMatchObject({
            language: 'en',
            pluginCustomStorage: {
                memory: { entries: [1, 2, 3] },
                shared: 'kept',
            },
            pluginStorageMeta: {
                memory: { plugin: 'memory-v3', updatedAt: 1 },
            },
        })
    })

    it('can omit and preserve the complete plugin store', () => {
        const { store, service } = createService()
        store.replaceFromProjection({
            ...sampleDatabase(),
            pluginCustomStorage: { large: 'data' },
        })
        const options = { excludeAllPluginStorage: true }
        const startup = service.getStartupProjection(options)

        expect(startup.database.pluginCustomStorage).toEqual({})
        service.patchDatabase(languageDelta(startup.database, 'en'), options)

        expect(store.exportProjection({ includeMessages: false }).pluginCustomStorage).toEqual({ large: 'data' })
    })

    it('treats missing-owner and non-V3 storage as unclassified', () => {
        const { store, service } = createService()
        store.replaceFromProjection({
            ...sampleDatabase(),
            plugins: [{ name: 'memory-v3', version: '3.0' }],
            pluginCustomStorage: { owned: 1, old: 2, missing: 3 },
            pluginStorageMeta: {
                owned: { plugin: 'memory-v3', updatedAt: 1 },
                old: { plugin: 'removed-plugin', updatedAt: 1 },
            },
        })

        const startup = service.getStartupProjection({
            excludeUnclassifiedPluginStorage: true,
        })

        expect(startup.database.pluginCustomStorage).toEqual({ owned: 1 })
        expect(startup.database.pluginStorageMeta).toEqual({
            owned: { plugin: 'memory-v3', updatedAt: 1 },
        })
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
            currentEtag: store.getState().projectionEtag,
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
        expect(store.getChatState('character-1', 'chat-1')?.chat.message).toEqual([
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

describe('database projection delta commits', () => {
    it.each(['personas', 'modelPresets'])('rejects duplicate %s IDs without applying any fields', field => {
        const { store, service } = createService()
        store.replaceFromProjection(sampleDatabase())
        const before = service.getStartupProjection()
        const incoming = {
            ...before.database,
            language: 'en',
            [field]: [{ id: 'duplicate', name: 'First' }, { id: 'duplicate', name: 'Second' }],
        }

        const error = thrownBy(() => service.patchDatabase({ changes: createDelta(before.database, incoming) }))

        expect(error).toBeInstanceOf(DatabaseProjectionValidationError)
        expect(error.statusCode).toBe(400)
        expect(service.getStartupProjection()).toEqual(before)
    })

    it('commits guarded deltas over unrelated canonical changes and rejects overlapping fields', () => {
        const { store, service } = createService()
        store.replaceFromProjection(sampleDatabase())
        const base = service.getStartupProjection().database
        const local = { ...base, language: 'en' }
        store.syncStartupProjection({ ...base, localOnlyRoot: { secret: false } })
        expect(service.patchDatabase({ changes: createDelta(base, local) }).success).toBe(true)
        expect(service.getStartupProjection().database).toMatchObject({ language: 'en', localOnlyRoot: { secret: false } })
        expect(service.patchDatabase({ changes: createDelta(base, local) }).success).toBe(true)
        expect(() => service.patchDatabase({ changes: createDelta(base, { ...base, language: 'ja' }) }))
            .toThrow(DatabaseProjectionConflictError)
        expect(service.getStartupProjection().database.language).toBe('en')
    })
    it.each([
        {
            change: 'root settings',
            commit: (store: any) => {
                const database = store.exportProjection({ includeMessages: false })
                database.localOnlyRoot = { secret: false }
                store.syncStartupProjection(database)
            },
        },
        {
            change: 'chat creation',
            commit: (store: any) => {
                const committed = store.commitChat('character-1', 'chat-2', {
                    id: 'chat-2', name: '새 채팅',
                    message: [{ chatId: 'new-message', role: 'user', data: '새 본문' }],
                }, undefined)
                expect(committed.projectionChanged).toBe(true)
            },
        },
        {
            change: 'chat metadata',
            commit: (store: any) => {
                const database = store.exportProjection({ includeMessages: false })
                database.characters[0].chats[0].name = 'Renamed on server'
                store.syncStartupProjection(database)
            },
        },
        {
            change: 'character creation',
            commit: (store: any) => {
                const database = store.exportProjection({ includeMessages: false })
                database.characters.push({
                    chaId: 'character-2', name: 'New character',
                    chats: [{ id: 'initial-chat', name: 'Initial chat', _stub: true }],
                })
                store.syncStartupProjection(database)
            },
        },
        {
            change: 'new message',
            commit: (store: any) => {
                const { chat, etag } = store.getChatState('character-1', 'chat-1')
                chat.message.push({ chatId: 'message-2', role: 'user', data: 'New message' })
                store.commitChat('character-1', chat.id, chat, etag)
            },
        },
    ])('continues saves after an independent $change commit with a stale cache', ({ commit }) => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        const staleCache = store.exportProjection({ includeMessages: false })
        const service = createDatabaseProjectionService({ appDataStore: store })
        commit(store)
        const durableDatabase = store.exportProjection()

        expect(service.patchDatabase(languageDelta(staleCache, 'en')))
            .toMatchObject({ success: true, changed: true })
        expect(store.exportProjection()).toEqual({ ...durableDatabase, language: 'en' })

        const accepted = service.getStartupProjection()
        expect(service.patchDatabase(languageDelta(accepted.database, 'ko')))
            .toMatchObject({ success: true, changed: true })
        expect(store.exportProjection()).toEqual(durableDatabase)
    })

    it('commits without replacing chat bodies', () => {
        const { store, service } = createService()
        store.replaceFromProjection(sampleDatabase())
        const startup = service.getStartupProjection()

        const result = service.patchDatabase(languageDelta(startup.database, 'en'))

        expect(result).toMatchObject({
            success: true,
            changed: true,
            appliedOperations: 1,
            revision: 2,
            etag: store.getState().projectionEtag,
        })
        expect(store.exportProjection().language).toBe('en')
        expect(store.getChatState('character-1', 'chat-1')?.chat.message).toEqual([
            { chatId: 'message-1', role: 'user', data: '본문' },
        ])
    })

    it('treats empty changes as a no-op', () => {
        const { sqlite, store, service } = createService()
        store.replaceFromProjection(sampleDatabase())
        const before = store.getState()
        const beforeChanges = (sqlite.prepare(
            'SELECT total_changes() AS count',
        ).get() as any).count

        const result = service.patchDatabase({ changes: [] })

        expect(result).toMatchObject({
            success: true,
            changed: false,
            appliedOperations: 0,
            revision: before.revision,
            etag: store.getState().projectionEtag,
        })
        expect(store.getState()).toEqual(before)
        expect((sqlite.prepare('SELECT total_changes() AS count').get() as any).count)
            .toBe(beforeChanges)
    })

    it('rejects malformed requests with typed validation errors', () => {
        const { service } = createService()

        expect(thrownBy(() => service.patchDatabase({ changes: {} })))
            .toBeInstanceOf(DatabaseProjectionValidationError)
        expect(thrownBy(() => service.patchDatabase({ patch: [] })))
            .toBeInstanceOf(DatabaseProjectionValidationError)
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

        const error = thrownBy(() => service.patchDatabase(languageDelta(startup.database, 'en')))

        expect(error).toBeInstanceOf(DatabaseProjectionConflictError)
        expect(error).toMatchObject({
            statusCode: 409,
            code: 'DATABASE_PROJECTION_CHANGED',
            currentRevision: 2,
            currentEtag: store.getState().projectionEtag,
        })
        expect(store.exportProjection().language).toBe('ja')
    })
})

describe('hidden-folder and server-owned projection transforms', () => {
    it('keeps data hidden from the view and restores server metadata', () => {
        const filterHiddenFolders = vi.fn((database: any) => {
            const visible = structuredClone(database)
            delete visible.localOnlyRoot
            return visible
        })
        const restoreServerOwnedMetadata = vi.fn((incoming: any, canonical: any) => {
            const restored = structuredClone(incoming)
            restored.statics.messages = canonical.statics.messages
            restored.characters[0].lastInteraction = canonical.characters[0].lastInteraction
            return restored
        })
        const { store, service } = createService({
            filterHiddenFolders,
            restoreServerOwnedMetadata,
        })
        store.replaceFromProjection(sampleDatabase())
        const startup = service.getStartupProjection({ hideFolders: true })

        expect(startup.database).not.toHaveProperty('localOnlyRoot')
        const edited = structuredClone(startup.database)
        edited.language = 'en'
        edited.statics.messages = 999
        edited.characters[0].lastInteraction = 999
        const result = service.patchDatabase({ changes: createDelta(startup.database, edited) }, { hideFolders: true })

        expect(result).toMatchObject({ success: true, appliedOperations: 3, revision: 2 })
        expect(store.exportProjection()).toMatchObject({
            language: 'en',
            statics: { messages: 7, imports: 2, clientValue: 'kept' },
            localOnlyRoot: { secret: true },
        })
        expect(store.exportProjection().characters[0].lastInteraction).toBe(123)
        expect(store.getChatState('character-1', 'chat-1')?.chat.message[0].data).toBe('본문')
        expect(restoreServerOwnedMetadata).toHaveBeenCalledOnce()
    })
})

describe('privacy guard deltas', () => {
    function guardedService() {
        const { store, service } = createService({ filterHiddenFolders, guardHiddenDelta })
        store.replaceFromProjection({
            characterOrder: ['shown', { id: 'F', name: 'Private', color: '', localOnly: true, data: ['secret'] }, 'other'],
            characters: [
                {
                    chaId: 'shown', name: 'Shown',
                    chatFolders: [{ id: 'CF', name: 'Hidden chats', localOnly: true }],
                    chats: [{ id: 'open', name: 'Open', message: [] }, { id: 'private', name: 'Private', folderId: 'CF', message: [] }],
                },
                { chaId: 'secret', name: 'Secret', chats: [] },
                { chaId: 'other', name: 'Other', chats: [] },
            ],
        })
        const visible = service.getStartupProjection({ hideFolders: true }).database
        return { store, service, visible }
    }

    it('applies a delta made on the filtered view without dropping hidden entries', () => {
        const { store, service, visible } = guardedService()
        const edited = structuredClone(visible)
        edited.characterOrder.reverse()
        edited.characters[0].name = 'Renamed'

        service.patchDatabase({ changes: createDelta(visible, edited) }, { hideFolders: true })

        const stored = store.exportProjection({ includeMessages: false })
        expect(stored.characterOrder.map((entry: any) => entry.id ?? entry)).toEqual(['other', 'F', 'shown'])
        expect(stored.characters.map((char: any) => char.chaId)).toEqual(['shown', 'secret', 'other'])
        expect(stored.characters[0].name).toBe('Renamed')
        expect(stored.characters[0].chats.map((chat: any) => chat.id)).toEqual(['open', 'private'])
    })

    it('deletes a character holding hidden chats and rejects a change naming a hidden ID', () => {
        const { store, service, visible } = guardedService()
        const edited = structuredClone(visible)
        edited.characters.shift()
        edited.characterOrder.shift()
        service.patchDatabase({ changes: createDelta(visible, edited) }, { hideFolders: true })
        expect(store.exportProjection().characters.map((char: any) => char.chaId)).toEqual(['secret', 'other'])

        const error = thrownBy(() => service.patchDatabase({ changes: [{
            kind: 'value', path: ['characters', { key: 'chaId', value: 'secret' }, 'name'],
            before: { exists: true, value: 'Secret' }, after: { exists: true, value: 'Leaked' },
        }] }, { hideFolders: true }))
        expect(error).toBeInstanceOf(DatabaseProjectionConflictError)
        expect(store.exportProjection().characters[0].name).toBe('Secret')
    })
})

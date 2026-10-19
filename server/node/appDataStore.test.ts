// @vitest-environment node
import Database from './sqlite.cjs'
import { afterEach, describe, expect, it } from 'vitest'
import { Packr, Unpackr } from 'msgpackr'
import appDataStorePkg from './appDataStore.cjs'
import chatStorePkg from './chatStore.cjs'

const {
    AppDataConflictError,
    createAppDataStore,
} = appDataStorePkg as any
const { computeChatEtag } = chatStorePkg as any

const openDatabases: Database.Database[] = []

function createStore() {
    const sqlite = new Database(':memory:')
    openDatabases.push(sqlite)
    return { sqlite, store: createAppDataStore(sqlite) }
}

function sampleDatabase() {
    return {
        characters: [{
            chaId: 'character-1',
            name: '해적 리수',
            image: 'assets/portrait.png',
            unknownCharacterField: { nested: false },
            chats: [{
                id: 'chat-1',
                name: '첫 채팅',
                folderId: null,
                modules: ['module-1'],
                localLore: 'kept in full chat content',
                message: [
                    { chatId: 'message-1', role: 'user', data: '' },
                    {
                        chatId: 'message-2',
                        role: 'char',
                        data: '안녕하세요 👋',
                        swipes: ['안녕', '반가워요'],
                        unknownMessageField: 0,
                    },
                ],
            }],
        }],
        language: 'ko',
        enabled: false,
        nullable: null,
        count: 0,
        botPresets: [{ id: 'preset-1', name: '기본', temperature: 80 }],
        activePromptPresetId: 'preset-1',
        modules: [{ id: 'module-1', name: 'Lore', lorebook: [] }],
        plugins: [{ name: 'legacy-plugin', version: '1.0.0' }],
        pluginV2: [{ id: 'plugin-v2', name: 'Plugin V2' }],
        personas: [{ id: 'persona-1', name: '선장' }],
        pluginCustomStorage: {
            empty: '',
            zero: 0,
            nested: { value: true },
        },
        unknownFutureRoot: { value: ['preserved'] },
    }
}

afterEach(() => {
    while (openDatabases.length > 0) openDatabases.pop()?.close()
})

describe('relational app data projection', () => {
    it('excludes device selection from writes and previously stored character rows', () => {
        const { sqlite, store } = createStore()
        const source = sampleDatabase()
        Object.assign(source.characters[0], { chatPage: 1, reloadKeys: 42 })
        store.replaceFromProjection(source)
        const packr = new Packr({ useRecords: false })
        const unpackr = new Unpackr({ useRecords: false })
        const row = sqlite.prepare('SELECT payload FROM app_characters').get() as { payload: Buffer }
        const metadata = unpackr.unpack(row.payload)
        expect(metadata).not.toHaveProperty('chatPage')
        const etag = store.projectionEtag({ includeMessages: false })
        const incoming = store.exportProjection({ includeMessages: false })
        incoming.characters[0].chatPage = 2
        expect(store.syncStartupProjection(incoming).changed).toBe(false)

        sqlite.prepare('UPDATE app_characters SET payload = ?').run(
            packr.pack({ ...metadata, chatPage: 2, reloadKeys: 42 }),
        )
        expect(store.exportProjection().characters[0]).not.toHaveProperty('chatPage')
        expect(store.exportProjection({ includeMessages: false }).characters[0]).not.toHaveProperty('chatPage')
        expect(store.listCharacterStorage()[0].character).not.toHaveProperty('chatPage')
        expect(store.projectionEtag({ includeMessages: false })).toBe(etag)
    })

    function auditWrites(sqlite: any, table: string, key: string) {
        sqlite.exec(`CREATE TEMP TABLE writes (operation TEXT, item_key TEXT)`)
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
            sqlite.exec(`CREATE TEMP TRIGGER audit_${operation} AFTER ${operation} ON ${table}
                BEGIN INSERT INTO writes VALUES ('${operation}', ${operation === 'DELETE' ? 'OLD' : 'NEW'}.${key}); END`)
        }
        return () => sqlite.prepare('SELECT operation, item_key FROM writes').all()
    }

    it('writes only added, edited, moved or removed messages, including metadata-only saves', () => {
        const { sqlite, store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        const writes = auditWrites(sqlite, 'app_messages', 'message_key')
        const save = (edit: (chat: any) => void) => {
            const chat = store.getChat('character-1', 'chat-1')
            const etag = computeChatEtag(chat)
            edit(chat)
            const result = store.commitChat('character-1', 'chat-1', chat, etag)
            expect(store.getChat('character-1', 'chat-1')).toEqual(result.chat)
            return result
        }
        save(chat => { chat.message.push({ chatId: 'message-3', role: 'user', data: 'new' }) })
        expect(writes()).toEqual([{ operation: 'INSERT', item_key: 'message-3' }])
        sqlite.exec('DELETE FROM writes')
        save(chat => { chat.message[1].swipes.push('edited swipe') })
        expect(writes()).toEqual([{ operation: 'UPDATE', item_key: 'message-2' }])
        sqlite.exec('DELETE FROM writes')
        save(chat => { chat.note = 'only content metadata changed' })
        expect(writes()).toEqual([])
        save(chat => { chat.message.reverse() })
        expect(writes().every((row: any) => row.operation === 'UPDATE' && row.item_key !== 'message-2')).toBe(true)
        expect(store.getChat('character-1', 'chat-1').message.map((m: any) => m.chatId))
            .toEqual(['message-3', 'message-2', 'message-1'])
        sqlite.exec('DELETE FROM writes')
        save(chat => { chat.message.pop() })
        expect(writes()).toEqual([{ operation: 'DELETE', item_key: 'message-1' }])
        const rows = sqlite.prepare('SELECT message_key, revision FROM app_messages ORDER BY position').all()
        expect(rows).toEqual([
            { message_key: 'message-3', revision: 5 },
            { message_key: 'message-2', revision: 3 },
        ])
        sqlite.exec('DELETE FROM writes')
        save(chat => { chat.message = [] })
        expect(writes()).toHaveLength(2)
        expect(writes().every((row: any) => row.operation === 'DELETE')).toBe(true)
    })

    it('rejects duplicate and missing message IDs without changing stored content', () => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        for (const message of [
            [{ chatId: 'same', data: 'a' }, { chatId: 'same', data: 'b' }],
            [{ data: 'new' }],
        ]) {
            const chat = store.getChat('character-1', 'chat-1')
            const state = store.getState()
            expect(() => store.commitChat('character-1', 'chat-1', { ...chat, message }, computeChatEtag(chat)))
                .toThrow()
            expect(store.getChat('character-1', 'chat-1')).toEqual(chat)
            expect(store.getState()).toEqual(state)
        }
    })

    it('assigns missing legacy message IDs once during initialization', () => {
        const { store } = createStore()
        const source = sampleDatabase()
        delete source.characters[0].chats[0].message[0].chatId

        store.replaceFromProjection(source)
        const chat = store.getChat('character-1', 'chat-1')
        expect(chat.message[0]).toMatchObject(source.characters[0].chats[0].message[0])
        expect(chat.message[0].chatId).toEqual(expect.any(String))
        expect(chat.message[0].chatId).not.toBe('')

        store.syncStartupProjection(store.exportProjection({ includeMessages: false }))
        expect(store.getChat('character-1', 'chat-1')).toEqual(chat)
    })

    it.each([
        ['botPresets', 'app_presets', 'item_key'],
        ['modules', 'app_modules', 'item_key'],
        ['plugins', 'app_plugins', 'item_key'],
        ['personas', 'app_personas', 'item_key'],
        ['pluginCustomStorage', 'app_plugin_storage', 'storage_key'],
    ])('reconciles %s through the same incremental payload writer', (field, table, key) => {
        const { sqlite, store } = createStore()
        const source: any = sampleDatabase()
        source[field] = field === 'pluginCustomStorage'
            ? { a: { name: 'a' }, b: { name: 'b' } }
            : [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }]
        store.replaceFromProjection(source)
        const writes = auditWrites(sqlite, table, key)
        const projection = store.exportProjection({ includeMessages: false })
        if (field === 'pluginCustomStorage') projection[field].b.name = 'changed'
        else projection[field][1].name = 'changed'
        store.syncStartupProjection(projection)
        expect(writes()).toEqual([{ operation: 'UPDATE', item_key: 'b' }])
        sqlite.exec('DELETE FROM writes')
        if (field === 'pluginCustomStorage') {
            delete projection[field].a
            projection[field].c = 'new'
        } else {
            projection[field] = [projection[field][1], { id: 'c', name: 'new' }, projection[field][0]]
        }
        store.syncStartupProjection(projection)
        expect(store.exportProjection({ includeMessages: false })).toEqual(projection)
        expect(writes().filter((row: any) => row.operation === 'INSERT'))
            .toEqual([{ operation: 'INSERT', item_key: 'c' }])
    })

    it('keeps incremental writes scoped and avoids assigning payloads for order-only changes', () => {
        const { sqlite, store } = createStore()
        const source = sampleDatabase()
        source.characters[0].chats.push({ ...structuredClone(source.characters[0].chats[0]), id: 'chat-2' })
        store.replaceFromProjection(source)
        const untouched = store.getChat('character-1', 'chat-2')
        sqlite.exec(`CREATE TEMP TRIGGER reject_payload_update BEFORE UPDATE OF payload ON app_messages
            BEGIN SELECT RAISE(ABORT, 'unexpected payload update'); END`)
        const chat = store.getChat('character-1', 'chat-1')
        const etag = computeChatEtag(chat)
        chat.message.reverse()
        store.commitChat('character-1', 'chat-1', chat, etag)
        expect(store.getChat('character-1', 'chat-1').message).toEqual(chat.message)
        expect(store.getChat('character-1', 'chat-2')).toEqual(untouched)
        expect(sqlite.prepare("SELECT revision FROM app_messages WHERE chat_id = 'chat-2'").all())
            .toEqual([{ revision: 1 }, { revision: 1 }])
    })

    it('rolls back row moves, deletes and revisions if incremental writing fails', () => {
        const { sqlite, store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        const before = store.exportProjection()
        const state = store.getState()
        sqlite.exec(`CREATE TEMP TRIGGER reject_message BEFORE INSERT ON app_messages
            WHEN NEW.message_key = 'reject' BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
        const chat = store.getChat('character-1', 'chat-1')
        expect(() => store.commitChat('character-1', 'chat-1', {
            ...chat, message: [chat.message[1], { chatId: 'reject', data: 'new' }],
        }, computeChatEtag(chat))).toThrow('test failure')
        expect(store.exportProjection()).toEqual(before)
        expect(store.getState()).toEqual(state)
        expect(sqlite.prepare('SELECT position, revision FROM app_messages ORDER BY position').all())
            .toEqual([{ position: 0, revision: 1 }, { position: 1, revision: 1 }])
    })

    it('round-trips a full compatibility projection without losing unknown fields or order', () => {
        const { store } = createStore()
        const source = sampleDatabase()

        const result = store.replaceFromProjection(source)

        expect(result.revision).toBe(1)
        expect(store.exportProjection()).toEqual(source)
        expect(Object.keys(store.exportProjection())).toEqual(Object.keys(source))
        expect(store.getState()).toMatchObject({
            schemaVersion: 1,
            revision: 1,
            initialized: true,
        })
    })

    it('stores independently edited domains and messages in separate tables', () => {
        const { sqlite, store } = createStore()
        store.replaceFromProjection(sampleDatabase())

        const count = (table: string) => sqlite.prepare(
            `SELECT COUNT(*) AS count FROM ${table}`,
        ).get() as { count: number }

        expect(count('app_root_fields').count).toBe(Object.keys(sampleDatabase()).length)
        expect(count('app_characters').count).toBe(1)
        expect(count('app_chats').count).toBe(1)
        expect(count('app_messages').count).toBe(2)
        expect(count('app_presets').count).toBe(1)
        expect(count('app_modules').count).toBe(1)
        expect(count('app_plugins').count).toBe(2)
        expect(count('app_personas').count).toBe(1)
        expect(count('app_plugin_storage').count).toBe(3)
        expect(sqlite.pragma('foreign_key_check')).toEqual([])
        expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
    })

    it('reports plugin storage size by known V3 owner without decoding all values', () => {
        const { store } = createStore()
        const source:any = sampleDatabase()
        source.plugins.push(
            { name: 'small-v3', displayName: 'Small V3', version: '3.0' },
            { name: 'memory-v3', displayName: 'Memory V3', version: '3.0' },
        )
        source.pluginCustomStorage.empty = 'x'
        source.pluginCustomStorage.nested = 'x'.repeat(1_000)
        source.pluginStorageMeta = {
            nested: { plugin: 'memory-v3', updatedAt: 1 },
            empty: { plugin: 'small-v3', updatedAt: 1 },
            zero: { plugin: 'missing-plugin', updatedAt: 1 },
        }
        store.replaceFromProjection(source)

        const stats = store.pluginStorageFootprint()

        expect(stats.plugins).toEqual([
            expect.objectContaining({ name: 'memory-v3', displayName: 'Memory V3' }),
            expect.objectContaining({ name: 'small-v3', displayName: 'Small V3' }),
        ])
        expect(stats.plugins[0].bytes).toBeGreaterThan(stats.plugins[1].bytes)
        expect(stats.unclassifiedBytes).toBeGreaterThan(0)
        expect(stats.totalBytes).toBe(
            stats.plugins[0].bytes + stats.plugins[1].bytes + stats.unclassifiedBytes,
        )
    })

    it('exports a startup projection containing chat stubs but no messages', () => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())

        const startup = store.exportProjection({ includeMessages: false })

        expect(startup.characters[0].chats[0]).toEqual({
            id: 'chat-1',
            name: '첫 채팅',
            folderId: null,
            modules: ['module-1'],
            _stub: true,
        })
        expect(startup.characters[0].chats[0]).not.toHaveProperty('message')
        expect(startup.characters[0].chats[0]).not.toHaveProperty('localLore')
    })

    it('reads one indexed chat without materializing the full projection', () => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())

        expect(store.getChatStubAt('character-1', 0)).toEqual({
            id: 'chat-1',
            name: '첫 채팅',
            folderId: null,
            modules: ['module-1'],
            _stub: true,
        })
        expect(store.hasChat('character-1', 'chat-1')).toBe(true)
        expect(store.hasChat('character-1', 'missing')).toBe(false)
        expect(store.getChat('character-1', 'chat-1')?.message).toHaveLength(2)
    })

    it('aggregates storage sizes without exporting chat messages', () => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())

        expect(store.estimateProjectionBytes()).toBeGreaterThan(0)
        expect(store.listCharacterStorage()).toEqual([
            expect.objectContaining({
                character: expect.objectContaining({
                    chaId: 'character-1',
                    name: '해적 리수',
                }),
                cardBytes: expect.any(Number),
                chatBytes: expect.any(Number),
            }),
        ])
        expect(store.listCharacterStorage()[0].chatBytes).toBeGreaterThan(0)
        expect(store.listModuleStorage()).toEqual([
            expect.objectContaining({
                module: expect.objectContaining({ id: 'module-1', name: 'Lore' }),
                bodyBytes: expect.any(Number),
            }),
        ])
    })

    it('uses revision compare-and-swap for destructive projection replacement', () => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())

        expect(() => store.replaceFromProjection(
            { characters: [], language: 'en' },
            { expectedRevision: 0 },
        )).toThrow(AppDataConflictError)

        expect(store.exportProjection()).toEqual(sampleDatabase())
        const committed = store.replaceFromProjection(
            { characters: [], language: 'en' },
            { expectedRevision: 1 },
        )
        expect(committed.revision).toBe(2)
        expect(store.exportProjection()).toEqual({ characters: [], language: 'en' })
    })

    it('repairs missing and duplicate physical ids once and keeps them stable', () => {
        const { store } = createStore()
        store.replaceFromProjection({
            characters: [
                { name: 'missing', chats: [{ name: 'missing chat', message: [] }] },
                { chaId: '@0', name: 'collision', chats: [] },
            ],
        })

        const first = store.exportProjection()
        const second = store.exportProjection()
        const characterIds = first.characters.map((character: any) => character.chaId)

        expect(new Set(characterIds).size).toBe(2)
        expect(first.characters[0].chats[0].id).toBeTruthy()
        expect(second).toEqual(first)
    })
})

describe('startup metadata synchronization', () => {
    it('merges changed root fields, deletes omitted fields, and leaves untouched rows alone', () => {
        const { sqlite, store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        const incoming = store.exportProjection({ includeMessages: false })
        incoming.language = 'en'
        delete incoming.unknownFutureRoot
        incoming.compactMode = true

        const result = store.syncStartupProjection(incoming, {
            expectedEtag: store.projectionEtag({ includeMessages: false }),
        })
        const exported = store.exportProjection()

        expect(result).toMatchObject({ changed: true, revision: 2 })
        expect(exported.language).toBe('en')
        expect(exported.compactMode).toBe(true)
        expect(exported).not.toHaveProperty('unknownFutureRoot')
        expect(exported.characters[0].chats[0].message).toHaveLength(2)
        const revisions = sqlite.prepare(`
          SELECT field_key, revision FROM app_root_fields
          WHERE field_key IN ('language', 'enabled', 'compactMode')
          ORDER BY field_key
        `).all()
        expect(revisions).toEqual([
            { field_key: 'compactMode', revision: 2 },
            { field_key: 'enabled', revision: 1 },
            { field_key: 'language', revision: 2 },
        ])
    })

    it('reorders characters and chats while keeping bodies attached to their ids', () => {
        const { sqlite, store } = createStore()
        const source = sampleDatabase()
        source.characters[0].chats.push({
            id: 'chat-2',
            name: '둘째 채팅',
            folderId: null,
            message: [{ chatId: 'message-3', role: 'user', data: '둘째 본문' }],
        })
        source.characters.push({
            chaId: 'character-2',
            name: '두 번째 캐릭터',
            chats: [{
                id: 'chat-3',
                name: '셋째 채팅',
                message: [{ chatId: 'message-4', role: 'user', data: '셋째 본문' }],
            }],
        })
        store.replaceFromProjection(source)
        const incoming = store.exportProjection({ includeMessages: false })
        incoming.characters.reverse()
        incoming.characters[1].chats.reverse()

        store.syncStartupProjection(incoming, { expectedRevision: 1 })

        const exported = store.exportProjection()
        expect(exported.characters.map((character: any) => character.chaId)).toEqual([
            'character-2',
            'character-1',
        ])
        expect(exported.characters[1].chats.map((chat: any) => chat.id)).toEqual([
            'chat-2',
            'chat-1',
        ])
        expect(exported.characters[1].chats[0].message[0].data).toBe('둘째 본문')
        expect(exported.characters[1].chats[1].message[1].data).toBe('안녕하세요 👋')
        expect(sqlite.pragma('foreign_key_check')).toEqual([])
        expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
    })

    it('adds and deletes chat metadata without treating stubs as chat bodies', () => {
        const { sqlite, store } = createStore()
        const source = sampleDatabase()
        source.characters[0].chats.push({
            id: 'chat-2',
            name: '보존할 채팅',
            message: [{ chatId: 'message-3', role: 'user', data: '보존됨' }],
        })
        store.replaceFromProjection(source)
        const incoming = store.exportProjection({ includeMessages: false })
        incoming.characters[0].chats = [
            incoming.characters[0].chats[1],
            { id: 'chat-3', name: '새 채팅', folderId: null, _stub: true },
        ]

        store.syncStartupProjection(incoming)

        expect(store.getChat('character-1', 'chat-1')).toBeUndefined()
        expect(store.getChat('character-1', 'chat-2').message[0].data).toBe('보존됨')
        expect(store.getChat('character-1', 'chat-3')).toEqual({
            id: 'chat-3',
            message: [],
            name: '새 채팅',
            folderId: null,
        })
        const messages = sqlite.prepare(`
          SELECT chat_id, COUNT(*) AS count FROM app_messages GROUP BY chat_id
        `).all()
        expect(messages).toEqual([{ chat_id: 'chat-2', count: 1 }])
    })

    it('reconciles stub metadata into the full chat and etag without replacing messages', () => {
        const { sqlite, store } = createStore()
        const source = sampleDatabase()
        source.characters[0].chats[0].folderId = 'old-folder'
        store.replaceFromProjection(source)
        const before = store.getChat('character-1', 'chat-1')
        const beforeEtag = computeChatEtag(before)
        const incoming = store.exportProjection({ includeMessages: false })
        incoming.characters[0].chats[0].name = '이름 변경'
        incoming.characters[0].chats[0].folderId = null

        const result = store.syncStartupProjection(incoming, {
            expectedEtag: store.projectionEtag({ includeMessages: false }),
        })
        const after = store.getChat('character-1', 'chat-1')

        expect(after).toMatchObject({
            id: 'chat-1',
            name: '이름 변경',
            folderId: null,
            localLore: 'kept in full chat content',
        })
        expect(after.message).toEqual(before.message)
        expect(computeChatEtag(after)).not.toBe(beforeEtag)
        expect(result.etag).toBe(store.projectionEtag({ includeMessages: false }))
        expect((sqlite.prepare(`
          SELECT content_etag AS etag FROM app_chats
          WHERE character_id = 'character-1' AND chat_id = 'chat-1'
        `).get() as any).etag).toBe(computeChatEtag(after))
        expect((sqlite.prepare(`
          SELECT MIN(revision) AS revision FROM app_messages
          WHERE character_id = 'character-1' AND chat_id = 'chat-1'
        `).get() as any).revision).toBe(1)
    })

    it('rejects stale startup hashes and revisions without changing rows', () => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        const staleProjection = store.exportProjection({ includeMessages: false })
        const staleEtag = store.projectionEtag({ includeMessages: false })
        const first = structuredClone(staleProjection)
        first.language = 'en'
        store.syncStartupProjection(first, { expectedEtag: staleEtag })

        expect(() => store.syncStartupProjection(staleProjection, {
            expectedEtag: staleEtag,
        })).toThrow(AppDataConflictError)
        expect(() => store.syncStartupProjection(staleProjection, {
            expectedRevision: 1,
        })).toThrow(AppDataConflictError)
        expect(store.exportProjection().language).toBe('en')
    })

    it('is an idempotent no-op for an unchanged startup projection', () => {
        const { sqlite, store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        const incoming = store.exportProjection({ includeMessages: false })
        const beforeState = store.getState()
        const beforeChanges = (sqlite.prepare(
            'SELECT total_changes() AS count',
        ).get() as any).count

        const result = store.syncStartupProjection(incoming, {
            expectedEtag: store.projectionEtag({ includeMessages: false }),
        })

        expect(result).toEqual({
            changed: false,
            revision: beforeState.revision,
            updatedAt: beforeState.updatedAt,
            etag: store.projectionEtag({ includeMessages: false }),
        })
        expect(store.getState()).toEqual(beforeState)
        expect((sqlite.prepare('SELECT total_changes() AS count').get() as any).count)
            .toBe(beforeChanges)
    })
})

describe('relational chat content CAS', () => {
    it('does not advance revision when an acknowledged chat body is retried unchanged', () => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        const chat = store.getChat('character-1', 'chat-1')
        const before = store.getState()

        const result = store.commitChat(
            'character-1', 'chat-1', chat, computeChatEtag(chat),
        )

        expect(result).toMatchObject({ changed: false, projectionChanged: false, revision: before.revision })
        expect(store.getState()).toEqual(before)
    })

    it('updates one chat body without changing its independently stored list metadata', () => {
        const { store } = createStore()
        const source = sampleDatabase()
        store.replaceFromProjection(source)
        const current = store.getChat('character-1', 'chat-1')
        const incoming = {
            ...current,
            name: 'stale client-side name',
            folderId: 'stale-folder',
            message: [...current.message, {
                chatId: 'message-3', role: 'user', data: 'new message',
            }],
        }

        const committed = store.commitChat(
            'character-1',
            'chat-1',
            incoming,
            computeChatEtag(current),
        )

        expect(committed.chat.name).toBe('첫 채팅')
        expect(committed.projectionChanged).toBe(false)
        expect(committed.chat.folderId).toBeNull()
        expect(committed.chat.message).toHaveLength(3)
        expect(store.exportProjection().characters[0].chats[0]).toEqual(committed.chat)
        expect(store.exportProjection({ includeMessages: false }).characters[0].chats[0].name)
            .toBe('첫 채팅')
    })

    it('does not resurrect optional metadata removed from the startup stub', () => {
        const { store } = createStore()
        const source = sampleDatabase()
        Object.assign(source.characters[0].chats[0], {
            lastDate: 123,
            folderId: 'folder-a',
            modules: ['module-a'],
        })
        store.replaceFromProjection(source)
        const startup = store.exportProjection({ includeMessages: false })
        const stub = startup.characters[0].chats[0]
        delete stub.lastDate
        delete stub.folderId
        delete stub.modules

        store.syncStartupProjection(startup)

        const hydrated = store.getChat('character-1', 'chat-1')
        expect(hydrated).not.toHaveProperty('lastDate')
        expect(hydrated).not.toHaveProperty('folderId')
        expect(hydrated).not.toHaveProperty('modules')
        expect(hydrated.message).toHaveLength(2)
    })

    it('rejects a stale writer and leaves canonical rows unchanged', () => {
        const { store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        const current = store.getChat('character-1', 'chat-1')
        const staleEtag = computeChatEtag({ ...current, message: [] })

        expect(() => store.commitChat(
            'character-1',
            'chat-1',
            { ...current, message: [{ chatId: 'bad', data: 'overwrite' }] },
            staleEtag,
        )).toThrow(AppDataConflictError)

        expect(store.getChat('character-1', 'chat-1')).toEqual(current)
    })

    it('allows unrelated chat writers to commit against their own etags', () => {
        const { store } = createStore()
        const source = sampleDatabase()
        source.characters[0].chats.push({
            id: 'chat-2',
            name: '둘째 채팅',
            folderId: null,
            modules: [],
            localLore: '',
            message: [{ chatId: 'message-a', role: 'user', data: 'A' }],
        })
        store.replaceFromProjection(source)
        const first = store.getChat('character-1', 'chat-1')
        const second = store.getChat('character-1', 'chat-2')

        store.commitChat(
            'character-1', 'chat-1',
            { ...first, message: [...first.message, { chatId: 'message-3', data: 'one' }] },
            computeChatEtag(first),
        )
        store.commitChat(
            'character-1', 'chat-2',
            { ...second, message: [...second.message, { chatId: 'message-b', data: 'two' }] },
            computeChatEtag(second),
        )

        expect(store.getChat('character-1', 'chat-1').message.at(-1).data).toBe('one')
        expect(store.getChat('character-1', 'chat-2').message.at(-1).data).toBe('two')
    })

    it('cascades chat messages when a chat is deleted', () => {
        const { sqlite, store } = createStore()
        store.replaceFromProjection(sampleDatabase())
        const chat = store.getChat('character-1', 'chat-1')

        const result = store.deleteChat(
            'character-1', 'chat-1', computeChatEtag(chat),
        )

        expect(result.deleted).toBe(true)
        expect(store.getChat('character-1', 'chat-1')).toBeUndefined()
        expect((sqlite.prepare('SELECT COUNT(*) AS count FROM app_messages').get() as any).count)
            .toBe(0)
        expect(sqlite.pragma('foreign_key_check')).toEqual([])
    })
})


describe('cleanup reference snapshot', () => {
    it('scans persisted chats including server-only characters, trash, greetings, swipes and summaries', () => {
        const { store } = createStore()
        store.replaceFromProjection({ characters: [
            { chaId: 'one', firstMessage: '{{inlay::greeting}}', alternateGreetings: ['alternate'], chats: [
                { id: 'chat', message: [{ role: 'char', data: '{{inlayed::server}}', swipes: ['{{inlayeddata::swipe}}'] },
                    { role: 'user', data: 'comment', isComment: true }], hypaV3Data: { summaries: [{ text: 'summary' }] } },
            ] },
            { chaId: 'trash', trashTime: 1, chats: [{ id: 'hidden', message: [{ role: 'char', data: '{{inlay::trash}}' }] }] },
        ] })
        const inlays = store.scanContentReferences('inlay', ['greeting', 'server', 'swipe', 'trash', 'unused'])
        expect(inlays.used).toEqual([true, true, true, true, false])
        expect(Object.keys(inlays).sort()).toEqual(['kind', 'scannedAt', 'used'])
        const candidates = ['{{inlay::greeting}}', 'alternate', '{{inlayed::server}}', '{{inlayeddata::swipe}}', 'summary', '{{inlay::trash}}', 'comment', 'unused']
        const translations = store.scanContentReferences('translation', candidates)
        expect(translations.used).toEqual([true, true, true, true, true, true, false, false])
        expect(Object.keys(translations).sort()).toEqual(['kind', 'scannedAt', 'used'])
        expect(JSON.stringify(translations)).not.toContain('summary')
        const before = store.getState().revision
        store.scanContentReferences('inlay', [])
        expect(store.getState().revision).toBe(before)
    })

    it('fails closed when stored messages cannot be decoded', () => {
        const { store, sqlite } = createStore()
        store.replaceFromProjection(sampleDatabase())
        sqlite.prepare('UPDATE app_messages SET payload = ?').run(Buffer.from([0xd9]))
        expect(() => store.scanContentReferences('inlay', ['known'])).toThrow()
        expect(() => store.scanContentReferences('translation', ['known'])).toThrow()
    })
})

it('protects hidden folder references without disclosing hidden messages, ids, or totals', () => {
    const { store } = createStore()
    store.replaceFromProjection({
        characters: [
            { chaId: 'hidden-character', firstMessage: 'secret greeting', chats: [{ id: 'hidden-chat', message: [{ role: 'char', data: 'secret text {{inlay::hidden-image}}' }] }] },
        ],
        characterOrder: [{ id: 'private', name: 'Private', localOnly: true, data: ['hidden-character'] }],
    })
    const result = store.scanContentReferences('translation', ['unused', 'secret greeting'])
    expect(result.used).toEqual([false, true])
    const wire = JSON.stringify(result)
    for (const value of ['secret', 'hidden', 'private', 'totalMessages', 'keys']) expect(wire).not.toContain(value)
    expect(store.scanContentReferences('inlay', ['hidden-image', 'unused']).used).toEqual([true, false])
    expect(() => store.scanContentReferences('translation')).toThrow('Invalid content reference candidates')
})

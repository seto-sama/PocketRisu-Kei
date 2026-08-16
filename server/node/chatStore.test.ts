// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import chatStorePkg from './chatStore.cjs'

const {
    computeChatEtag,
    createFullChatStore,
    commitChatContent,
    stripChatsFromDb,
    reassembleFullDb,
    findStubFlagLossChats,
    createCanonicalChatService,
    CanonicalChatCommitError,
} = chatStorePkg as any

function createServiceHarness(initialChat: any, overrides: Record<string, any> = {}) {
    const chats = new Map([[initialChat.id, structuredClone(initialChat)]])
    const publishChatCommitted = vi.fn()
    const persistNow = vi.fn(async () => {})
    const schedulePersist = vi.fn()
    const service = createCanonicalChatService({
        queueStorageOperation: (operation: () => Promise<any>) => operation(),
        ensureChatStore: vi.fn(),
        getChat: (_characterId: string, chatId: string) => chats.get(chatId),
        replaceChat: (_characterId: string, chatId: string, chat: any) => {
            if (chat) chats.set(chatId, chat)
            else chats.delete(chatId)
        },
        commitChatContent: (
            characterId: string,
            chatId: string,
            chat: any,
            expectedEtag: string,
            options: any,
        ) => commitChatContent(
            new Map([[characterId, chats]]),
            characterId,
            chatId,
            chat,
            expectedEtag,
            options,
        ),
        computeChatEtag,
        getActiveGenerationWorkflow: () => undefined,
        getLatestGenerationWorkflow: () => undefined,
        persistNow,
        schedulePersist,
        publishChatCommitted,
        ...overrides,
    })
    return { chats, persistNow, publishChatCommitted, schedulePersist, service }
}

describe('full chat payload store', () => {
    it('round-trips full chats through a metadata-only database view', () => {
        const chat = {
            id: 'room', name: 'Room', folderId: null,
            message: [{ chatId: 'm1', role: 'char', data: 'hello' }],
        }
        const database = { characters: [{ chaId: 'character', chats: [chat] }] }
        const store = createFullChatStore(structuredClone(database))
        const stripped = stripChatsFromDb(database)

        expect(stripped.characters[0].chats[0]).toEqual({
            id: 'room', name: 'Room', folderId: null, _stub: true,
        })
        expect(reassembleFullDb(stripped, store)).toEqual(database)
    })

    it('removes browser runtime fields from the server database view', () => {
        const database = {
            characters: [{
                chaId: 'character',
                reloadKeys: 17,
                chats: [{ id: 'room', name: 'Room', message: [] }],
            }],
        }

        const stripped = stripChatsFromDb(database)
        expect(stripped.characters[0]).not.toHaveProperty('reloadKeys')
        expect(database.characters[0].reloadKeys).toBe(17)
    })

    it('reports metadata-only chats that lost their stub marker', () => {
        const malformed = {
            characters: [{ chaId: 'character', chats: [{ id: 'room', name: 'Room' }] }],
        }

        expect(findStubFlagLossChats(malformed)).toEqual([{
            chaId: 'character', charIndex: 0, chatIndex: 0, chatId: 'room',
        }])
    })
})

describe('chat content compare-and-swap', () => {
    it('accepts the current version and advances the chat etag', () => {
        const current = { id: 'room', message: [{ chatId: 'm1', role: 'char', data: 'old' }] }
        const incoming = { id: 'room', message: [{ chatId: 'm1', role: 'char', data: 'new' }] }
        const store = new Map([['character', new Map([['room', current]])]])

        const result = commitChatContent(
            store, 'character', 'room', incoming, computeChatEtag(current),
        )

        expect(result.success).toBe(true)
        expect(result.etag).toBe(computeChatEtag(incoming))
        expect(store.get('character')?.get('room')).toEqual(incoming)
    })

    it('rejects a stale writer without changing canonical chat content', () => {
        const stale = { id: 'room', message: [{ chatId: 'm1', role: 'char', data: 'stale' }] }
        const current = { id: 'room', message: [{ chatId: 'm1', role: 'char', data: 'canonical' }] }
        const store = new Map([['character', new Map([['room', current]])]])

        const result = commitChatContent(
            store, 'character', 'room', stale, computeChatEtag(stale),
        )

        expect(result).toMatchObject({
            success: false,
            conflict: true,
            currentEtag: computeChatEtag(current),
        })
        expect(store.get('character')?.get('room')).toEqual(current)
    })

    it('requires a version for an existing chat when the public boundary requests it', () => {
        const current = { id: 'room', message: [] }
        const store = new Map([['character', new Map([['room', current]])]])

        const result = commitChatContent(
            store, 'character', 'room', { id: 'room', message: [] }, undefined,
            { requireExpected: true },
        )

        expect(result).toMatchObject({ success: false, conflict: true })
        expect(store.get('character')?.get('room')).toEqual(current)
    })
})

describe('canonical chat service', () => {
    it('commits generation input through the immediate durable boundary', async () => {
        const initial = { id: 'room-1', message: [] }
        const next = { id: 'room-1', message: [{ role: 'user', data: 'hello' }] }
        const harness = createServiceHarness(initial)

        const result = await harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: next,
            expectedEtag: computeChatEtag(initial),
        })

        expect(result.chat).toEqual(next)
        expect(harness.persistNow).toHaveBeenCalledWith({
            characterId: 'character-1',
            generationInput: true,
        })
        expect(harness.publishChatCommitted).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'generation-input', chatId: 'room-1' }),
            undefined,
        )
    })

    it('rolls memory back when immediate persistence fails', async () => {
        const initial = { id: 'room-1', message: [] }
        const failure = new Error('disk full')
        const harness = createServiceHarness(initial, {
            persistNow: vi.fn(async () => { throw failure }),
        })

        await expect(harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: { id: 'room-1', message: [{ role: 'user', data: 'hello' }] },
            expectedEtag: computeChatEtag(initial),
        })).rejects.toBe(failure)
        expect(harness.chats.get('room-1')).toEqual(initial)
        expect(harness.publishChatCommitted).not.toHaveBeenCalled()
    })

    it('rejects a stale ordinary edit at the shared CAS boundary', async () => {
        const initial = { id: 'room-1', message: [{ role: 'user', data: 'current' }] }
        const harness = createServiceHarness(initial)

        await expect(harness.service.commitUserEdit({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: { id: 'room-1', message: [{ role: 'user', data: 'stale' }] },
            expectedEtag: 'stale-etag',
        })).rejects.toBeInstanceOf(CanonicalChatCommitError)
        expect(harness.schedulePersist).not.toHaveBeenCalled()
    })

    it('persists and finalizes a generation result before publishing it', async () => {
        const input = {
            id: 'room-1',
            message: [{ role: 'user', data: 'hello', chatId: 'user-1' }],
        }
        const generated = {
            id: 'room-1',
            message: [
                ...input.message,
                { role: 'char', data: 'result', chatId: 'generated-1' },
            ],
        }
        const calls: string[] = []
        const harness = createServiceHarness(input, {
            persistNow: vi.fn(async () => { calls.push('persist') }),
            publishChatCommitted: vi.fn(() => { calls.push('publish') }),
        })

        const result = await harness.service.commitGenerationResult({
            job: { characterId: 'character-1', roomId: 'room-1' },
            workflow: {
                context: {
                    inputCommit: { chat: input },
                    postprocess: { messageChatId: 'generated-1' },
                },
            },
            chat: generated,
            finalize: () => { calls.push('finalize') },
        })

        expect(result.chat).toEqual({ ...generated, isStreaming: false })
        expect(calls).toEqual(['persist', 'finalize', 'publish'])
    })
})

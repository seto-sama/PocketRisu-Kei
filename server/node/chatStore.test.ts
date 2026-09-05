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
    const ensureChatStore = vi.fn()
    const service = createCanonicalChatService({
        queueStorageOperation: (operation: () => Promise<any>) => operation(),
        ensureChatStore,
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
    return {
        chats,
        ensureChatStore,
        persistNow,
        publishChatCommitted,
        schedulePersist,
        service,
    }
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
    it('commits a server-owned image projection and publishes the canonical chat', async () => {
        const initial = { id: 'room-1', message: [{ chatId: 'image-1', data: 'old' }] }
        const harness = createServiceHarness(initial)

        const result = await harness.service.commitServerMutation({
            characterId: 'character-1',
            chatId: 'room-1',
            reason: 'image-generation-result',
            mutate: (chat: any) => {
                chat.message[0].data = '{{inlayed::generated-1}}'
            },
        })

        expect(result.chat.message[0].data).toBe('{{inlayed::generated-1}}')
        expect(harness.persistNow).toHaveBeenCalledWith(expect.objectContaining({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: expect.objectContaining({
                message: [expect.objectContaining({ data: '{{inlayed::generated-1}}' })],
            }),
        }))
        expect(harness.publishChatCommitted).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'image-generation-result' }),
            undefined,
        )
    })

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
            chatId: 'room-1',
            chat: next,
            generationInput: true,
        })
        expect(harness.publishChatCommitted).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'generation-input', chatId: 'room-1' }),
            undefined,
        )
    })

    it("accepts generation input already committed by this client's autosave", async () => {
        const beforeEdit = { id: 'room-1', message: [] }
        const submitted = { id: 'room-1', message: [{ role: 'user', data: 'hello' }] }
        const harness = createServiceHarness(submitted)

        const result = await harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: submitted,
            expectedEtag: computeChatEtag(beforeEdit),
        })

        expect(result.chat).toEqual(submitted)
        expect(result.etag).toBe(computeChatEtag(submitted))
        expect(harness.persistNow).toHaveBeenCalledWith({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: submitted,
            generationInput: true,
        })
    })

    it('still rejects stale generation input when canonical content differs', async () => {
        const beforeEdit = { id: 'room-1', message: [] }
        const canonical = { id: 'room-1', message: [{ role: 'user', data: 'other edit' }] }
        const harness = createServiceHarness(canonical)

        await expect(harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: { id: 'room-1', message: [{ role: 'user', data: 'my edit' }] },
            expectedEtag: computeChatEtag(beforeEdit),
        })).rejects.toBeInstanceOf(CanonicalChatCommitError)
        expect(harness.persistNow).not.toHaveBeenCalled()
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

    it('passes the committed chat identity to the durable user-edit boundary', async () => {
        const initial = { id: 'room-1', message: [] }
        const next = { id: 'room-1', message: [{ role: 'user', data: 'saved' }] }
        const harness = createServiceHarness(initial)

        await harness.service.commitUserEdit({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: next,
            expectedEtag: computeChatEtag(initial),
        })

        expect(harness.schedulePersist).toHaveBeenCalledWith({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: next,
        })
        expect(harness.ensureChatStore).toHaveBeenCalledWith('character-1', 'room-1')
    })

    it('adopts metadata and etag reconciled by the durable chat store', async () => {
        const initial = {
            id: 'room-1', name: 'canonical name', folderId: null, message: [],
        }
        const submitted = {
            id: 'room-1', name: 'stale name', folderId: 'stale-folder',
            message: [{ role: 'user', data: 'saved' }],
        }
        const durableChat = {
            ...submitted,
            name: 'canonical name',
            folderId: null,
        }
        const durableEtag = computeChatEtag(durableChat)
        const schedulePersist = vi.fn(async () => ({
            chat: durableChat,
            etag: durableEtag,
            revision: 7,
        }))
        const harness = createServiceHarness(initial, { schedulePersist })

        const result = await harness.service.commitUserEdit({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: submitted,
            expectedEtag: computeChatEtag(initial),
            originClientId: 'client-a',
        })

        expect(result).toMatchObject({
            success: true,
            chat: durableChat,
            etag: durableEtag,
            revision: 7,
        })
        expect(harness.chats.get('room-1')).toEqual(durableChat)
        expect(harness.publishChatCommitted).toHaveBeenCalledWith({
            characterId: 'character-1',
            chatId: 'room-1',
            etag: durableEtag,
            reason: 'user-edit',
        }, 'client-a')
    })

    it('treats an identical user-edit retry after a lost response as idempotent', async () => {
        const before = { id: 'room-1', message: [] }
        const alreadyCommitted = {
            id: 'room-1',
            message: [{ role: 'user', data: 'saved' }],
        }
        const harness = createServiceHarness(alreadyCommitted)

        const result = await harness.service.commitUserEdit({
            characterId: 'character-1',
            chatId: 'room-1',
            chat: alreadyCommitted,
            expectedEtag: computeChatEtag(before),
        })

        expect(result.etag).toBe(computeChatEtag(alreadyCommitted))
        expect(harness.schedulePersist).toHaveBeenCalledOnce()
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

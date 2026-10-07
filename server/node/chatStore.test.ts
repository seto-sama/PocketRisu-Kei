// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import chatStorePkg from './chatStore.cjs'
import appDataStorePkg from './appDataStore.cjs'
import Database from './sqlite.cjs'
import { createDelta } from '../../shared/guardedDelta.mjs'

const {
    computeChatEtag,
    createFullChatStore,
    commitChatContent,
    stripChatsFromDb,
    reassembleFullDb,
    createCanonicalChatService,
    CanonicalChatCommitError,
} = chatStorePkg as any
const { createAppDataStore } = appDataStorePkg as any

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
        getGenerationWorkflowInputChat: () => undefined,
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
    it('rejects duplicate message IDs before a server mutation commit', async () => {
        const initial = { id: 'room-1', message: [{ chatId: 'message-1', role: 'user', data: 'hello' }] }
        const next = { ...initial, message: [...initial.message, { ...initial.message[0], data: 'duplicate' }] }
        const harness = createServiceHarness(initial)
        const request = harness.service.commitServerMutation({
            characterId: 'character-1', chatId: initial.id, mutate: () => next,
        })

        await expect(request).rejects.toMatchObject({ httpStatus: 400 })
        expect(harness.chats.get(initial.id)).toEqual(initial)
        expect(harness.persistNow).not.toHaveBeenCalled()
        expect(harness.publishChatCommitted).not.toHaveBeenCalled()
    })

    it.each(['user', 'server'])('keeps runtime and legacy bookmark fields out of %s commits', async kind => {
        const base = { id: 'room-1', message: [{ chatId: 'message', role: 'user', data: 'text' }] }
        const edited = { ...base, note: 'edited', isStreaming: true, _stub: true, _placeholder: true, bookmarks: ['message'], bookmarkNames: { message: 'name' }, bookmarkTagIds: { message: ['tag'] } }
        const harness = createServiceHarness(base)
        const input = { characterId: 'character-1', chatId: 'room-1', changes: createDelta(base, edited) }
        const result = kind === 'user'
            ? await harness.service.commitUserDelta(input)
            : await harness.service.commitServerMutation({
                characterId: input.characterId, chatId: input.chatId, mutate: () => edited,
            })
        expect(result.chat).toEqual({ ...base, note: 'edited' })
    })

    it('applies a deletion over a concurrently committed image without a historical version', async () => {
        const base = { id: 'room-1', message: [
            { chatId: 'old', role: 'user', data: 'old' },
        ] }
        const current = { ...base, message: [...base.message, { chatId: 'image', role: 'char', data: 'image' }] }
        const harness = createServiceHarness(current)
        const result = await harness.service.commitUserDelta({
            characterId: 'character-1', chatId: 'room-1',
            changes: createDelta(base, { ...base, message: [] }),
        })
        expect(result.chat.message).toEqual([current.message[1]])
        expect(harness.chats.get('room-1')).toEqual(result.chat)
        expect(harness.schedulePersist).toHaveBeenCalledOnce()
    })

    it('rejects edits to the same message and keeps the failed batch out of persistence', async () => {
        const base = { id: 'room-1', note: 'before', message: [{ chatId: 'same', role: 'user', data: 'old' }] }
        const current = { ...base, message: [{ ...base.message[0], data: 'remote' }] }
        const harness = createServiceHarness(current)
        await expect(harness.service.commitUserDelta({
            characterId: 'character-1', chatId: 'room-1',
            changes: createDelta(base, { ...base, note: 'local', message: [{ ...base.message[0], data: 'local' }] }),
        })).rejects.toMatchObject({ httpStatus: 409, code: 'CHAT_CONTENT_CHANGED' })
        expect(harness.chats.get('room-1')).toEqual(current)
        expect(harness.schedulePersist).not.toHaveBeenCalled()
    })

    it('uses the same guarded delta for generation input and preserves independent server additions', async () => {
        const base = { id: 'room-1', message: [{ chatId: 'old', role: 'user', data: 'old' }] }
        const current = { ...base, message: [...base.message, { chatId: 'image', role: 'char', data: 'image' }] }
        const input = { ...base, message: [...base.message, { chatId: 'new', role: 'user', data: 'new prompt' }] }
        const harness = createServiceHarness(current)
        const result = await harness.service.commitGenerationInput({
            characterId: 'character-1', chatId: 'room-1',
            changes: createDelta(base, input),
        })
        expect(result.chat.message.map(message => message.chatId)).toEqual(['old', 'new', 'image'])
        expect(harness.persistNow).toHaveBeenCalledWith(expect.objectContaining({ generationInput: true }))
    })
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
        const next = { id: 'room-1', message: [{ chatId: 'message-1', role: 'user', data: 'hello' }] }
        const harness = createServiceHarness(initial)

        const result = await harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(initial, next),
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
        const submitted = { id: 'room-1', message: [{ chatId: 'message-1', role: 'user', data: 'hello' }] }
        const harness = createServiceHarness(submitted)

        const result = await harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(beforeEdit, submitted),
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
        const canonical = { id: 'room-1', message: [{ chatId: 'message-1', role: 'user', data: 'other edit' }] }
        const submitted = { id: 'room-1', message: [{ chatId: 'message-1', role: 'user', data: 'my edit' }] }
        const harness = createServiceHarness(canonical)

        await expect(harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(beforeEdit, submitted),
        })).rejects.toBeInstanceOf(CanonicalChatCommitError)
        expect(harness.persistNow).not.toHaveBeenCalled()
    })

    it('rolls memory back when immediate persistence fails', async () => {
        const initial = { id: 'room-1', message: [] }
        const next = { id: 'room-1', message: [{ chatId: 'message-1', role: 'user', data: 'hello' }] }
        const failure = new Error('disk full')
        const harness = createServiceHarness(initial, {
            persistNow: vi.fn(async () => { throw failure }),
        })

        await expect(harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(initial, next),
        })).rejects.toBe(failure)
        expect(harness.chats.get('room-1')).toEqual(initial)
        expect(harness.publishChatCommitted).not.toHaveBeenCalled()
    })

    it('passes the committed chat identity to the durable user-edit boundary', async () => {
        const initial = { id: 'room-1', message: [] }
        const next = { id: 'room-1', message: [{ chatId: 'saved-1', role: 'user', data: 'saved' }] }
        const harness = createServiceHarness(initial)

        await harness.service.commitUserDelta({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(initial, next),
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
            message: [{ chatId: 'saved-1', role: 'user', data: 'saved' }],
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

        const result = await harness.service.commitUserDelta({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(initial, submitted),
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
            message: [{ chatId: 'saved-1', role: 'user', data: 'saved' }],
        }
        const harness = createServiceHarness(alreadyCommitted)

        const result = await harness.service.commitUserDelta({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(before, alreadyCommitted),
        })

        expect(result.etag).toBe(computeChatEtag(alreadyCommitted))
        expect(harness.schedulePersist).toHaveBeenCalledOnce()
    })

    it('persists and finalizes a generation result before publishing it', async () => {
        const input = {
            id: 'room-1',
            name: 'Room',
            message: [{ role: 'user', data: 'hello', chatId: 'user-1' }],
        }
        const generated = {
            ...input,
            message: [
                ...input.message,
                { role: 'char', data: 'result', chatId: 'generated-1' },
            ],
        }
        const sqlite = new Database(':memory:')
        try {
            const store = createAppDataStore(sqlite)
            store.replaceFromProjection({ characters: [{ chaId: 'character-1', chats: [input] }] })
            const calls: string[] = []
            const persistNow = vi.fn(async ({ characterId, chatId, chat }: any) => {
                calls.push('persist')
                return store.commitChat(characterId, chatId, chat, undefined, { requireExpected: false })
            })
            const harness = createServiceHarness(input, {
                persistNow,
                publishChatCommitted: vi.fn(() => { calls.push('publish') }),
                getGenerationWorkflowInputChat: () => input,
            })

            const result = await harness.service.commitGenerationResult({
                job: { characterId: 'character-1', roomId: 'room-1' },
                workflow: {
                    workflowId: 'workflow-1',
                    context: {
                        postprocess: {
                            chatPatch: [], character: {}, messageChatId: 'generated-1',
                        },
                    },
                },
                chat: generated,
                finalize: () => { calls.push('finalize') },
            })

            expect(persistNow).toHaveBeenCalledWith(expect.objectContaining({ chat: generated }))
            expect(result.chat).toEqual(generated)
            expect(store.getChat('character-1', 'room-1')).toEqual(result.chat)
            expect(calls).toEqual(['persist', 'finalize', 'publish'])
        } finally {
            sqlite.close()
        }
    })
})

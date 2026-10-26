// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import chatStorePkg from './chatStore.cjs'
import appDataStorePkg from './appDataStore.cjs'
import Database from './sqlite.cjs'
import { createDelta } from '../shared/guardedDelta.mjs'

const {
    computeChatEtag,
    createCanonicalChatService,
    CanonicalChatCommitError,
} = chatStorePkg as any
const { createAppDataStore } = appDataStorePkg as any

const openDatabases: Database.Database[] = []
afterEach(() => {
    while (openDatabases.length > 0) openDatabases.pop()?.close()
})

const room = (fields: Record<string, any> = {}) => ({ id: 'room-1', name: 'Room', message: [] as any[], ...fields })

// The service runs against the real relational store, so CAS and metadata
// reconciliation are the production ones rather than a test double.
function createServiceHarness(initialChat: any, overrides: Record<string, any> = {}) {
    const sqlite = new Database(':memory:')
    openDatabases.push(sqlite)
    const store = createAppDataStore(sqlite)
    store.replaceFromProjection({ characters: [{ chaId: 'character-1', chats: [initialChat] }] })
    const commit = async ({ characterId, chatId, chat, expectedEtag }: any) =>
        store.commitChat(characterId, chatId, chat, expectedEtag)
    const persistChat = vi.fn(commit)
    const publishChatCommitted = vi.fn()
    const service = createCanonicalChatService({
        queueStorageOperation: (operation: () => Promise<any>) => operation(),
        loadChat: async (characterId: string, chatId: string) => store.getChatState(characterId, chatId),
        getGenerationWorkflowInputChat: () => undefined,
        persistChat,
        publishChatCommitted,
        ...overrides,
    })
    const stored = () => store.getChatState('character-1', initialChat.id)
    return {
        store,
        stored: () => stored()?.chat,
        replaceStored: (chat: any) => store.commitChat('character-1', chat.id, chat, stored()?.etag),
        persistChat,
        publishChatCommitted,
        service,
    }
}

describe('canonical chat service', () => {
    it('rejects duplicate message IDs before a server mutation commit', async () => {
        const initial = room({ message: [{ chatId: 'message-1', role: 'user', data: 'hello' }] })
        const next = { ...initial, message: [...initial.message, { ...initial.message[0], data: 'duplicate' }] }
        const harness = createServiceHarness(initial)
        const request = harness.service.commitServerMutation({
            characterId: 'character-1', chatId: initial.id, mutate: () => next,
        })

        await expect(request).rejects.toMatchObject({ httpStatus: 400 })
        expect(harness.stored()).toEqual(initial)
        expect(harness.persistChat).not.toHaveBeenCalled()
        expect(harness.publishChatCommitted).not.toHaveBeenCalled()
    })

    it.each(['user', 'server'])('keeps runtime and legacy bookmark fields out of %s commits', async kind => {
        const base = room({ message: [{ chatId: 'message', role: 'user', data: 'text' }] })
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
        const base = room({ message: [{ chatId: 'old', role: 'user', data: 'old' }] })
        const current = { ...base, message: [...base.message, { chatId: 'image', role: 'char', data: 'image' }] }
        const harness = createServiceHarness(current)
        const result = await harness.service.commitUserDelta({
            characterId: 'character-1', chatId: 'room-1',
            changes: createDelta(base, { ...base, message: [] }),
        })
        expect(result.chat.message).toEqual([current.message[1]])
        expect(harness.stored()).toEqual(result.chat)
    })

    it('rejects edits to the same message and keeps the failed batch out of persistence', async () => {
        const base = room({ note: 'before', message: [{ chatId: 'same', role: 'user', data: 'old' }] })
        const current = { ...base, message: [{ ...base.message[0], data: 'remote' }] }
        const harness = createServiceHarness(current)
        await expect(harness.service.commitUserDelta({
            characterId: 'character-1', chatId: 'room-1',
            changes: createDelta(base, { ...base, note: 'local', message: [{ ...base.message[0], data: 'local' }] }),
        })).rejects.toMatchObject({ httpStatus: 409, code: 'CHAT_CONTENT_CHANGED' })
        expect(harness.stored()).toEqual(current)
        expect(harness.persistChat).not.toHaveBeenCalled()
    })

    it('commits generation input immediately over independent server additions', async () => {
        const base = room({ message: [{ chatId: 'old', role: 'user', data: 'old' }] })
        const current = { ...base, message: [...base.message, { chatId: 'image', role: 'char', data: 'image' }] }
        const input = { ...base, message: [...base.message, { chatId: 'new', role: 'user', data: 'new prompt' }] }
        const harness = createServiceHarness(current)
        const result = await harness.service.commitGenerationInput({
            characterId: 'character-1', chatId: 'room-1',
            changes: createDelta(base, input),
        })
        expect(result.chat.message.map(message => message.chatId)).toEqual(['old', 'new', 'image'])
        expect(harness.persistChat).toHaveBeenCalledWith(expect.objectContaining({ generationInput: true }))
        expect(harness.publishChatCommitted).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'generation-input', chatId: 'room-1' }),
            undefined,
        )
    })

    it('commits a server-owned image projection and publishes the canonical chat', async () => {
        const harness = createServiceHarness(room({ message: [{ chatId: 'image-1', data: 'old' }] }))

        const result = await harness.service.commitServerMutation({
            characterId: 'character-1',
            chatId: 'room-1',
            reason: 'image-generation-result',
            mutate: (chat: any) => {
                chat.message[0].data = '{{inlayed::generated-1}}'
            },
        })

        expect(result.chat.message[0].data).toBe('{{inlayed::generated-1}}')
        expect(harness.stored()).toEqual(result.chat)
        expect(harness.publishChatCommitted).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'image-generation-result' }),
            undefined,
        )
    })

    it("accepts generation input already committed by this client's autosave", async () => {
        const beforeEdit = room()
        const submitted = room({ message: [{ chatId: 'message-1', role: 'user', data: 'hello' }] })
        const harness = createServiceHarness(submitted)
        const etag = harness.store.getChatState('character-1', 'room-1').etag

        const result = await harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(beforeEdit, submitted),
        })

        expect(result.chat).toEqual(submitted)
        expect(result.etag).toBe(etag)
    })

    it('still rejects stale generation input when canonical content differs', async () => {
        const beforeEdit = room()
        const canonical = room({ message: [{ chatId: 'message-1', role: 'user', data: 'other edit' }] })
        const submitted = room({ message: [{ chatId: 'message-1', role: 'user', data: 'my edit' }] })
        const harness = createServiceHarness(canonical)

        await expect(harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(beforeEdit, submitted),
        })).rejects.toBeInstanceOf(CanonicalChatCommitError)
        expect(harness.persistChat).not.toHaveBeenCalled()
    })

    it('does not publish when immediate persistence fails', async () => {
        const initial = room()
        const next = room({ message: [{ chatId: 'message-1', role: 'user', data: 'hello' }] })
        const failure = new Error('disk full')
        const harness = createServiceHarness(initial, {
            persistChat: vi.fn(async () => { throw failure }),
        })

        await expect(harness.service.commitGenerationInput({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(initial, next),
        })).rejects.toBe(failure)
        expect(harness.stored()).toEqual(initial)
        expect(harness.publishChatCommitted).not.toHaveBeenCalled()
    })

    it('keeps list metadata from the durable store over a stale submitted body', async () => {
        const initial = room({ name: 'canonical name', folderId: null })
        const submitted = room({
            name: 'stale name', folderId: 'stale-folder',
            message: [{ chatId: 'saved-1', role: 'user', data: 'saved' }],
        })
        const harness = createServiceHarness(initial)

        const result = await harness.service.commitUserDelta({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(initial, submitted),
            originClientId: 'client-a',
        })

        expect(result.chat).toEqual({ ...submitted, name: 'canonical name', folderId: null })
        expect(harness.publishChatCommitted).toHaveBeenCalledWith({
            characterId: 'character-1',
            chatId: 'room-1',
            etag: computeChatEtag(result.chat),
            reason: 'user-edit',
        }, 'client-a')
    })

    it('treats an identical user-edit retry after a lost response as idempotent', async () => {
        const before = room()
        const alreadyCommitted = room({ message: [{ chatId: 'saved-1', role: 'user', data: 'saved' }] })
        const harness = createServiceHarness(alreadyCommitted)
        const etag = harness.store.getChatState('character-1', 'room-1').etag

        const result = await harness.service.commitUserDelta({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(before, alreadyCommitted),
        })

        expect(result.etag).toBe(etag)
        expect(harness.persistChat).toHaveBeenCalledOnce()
    })

    it('persists and finalizes a generation result before publishing it', async () => {
        const input = room({ message: [{ role: 'user', data: 'hello', chatId: 'user-1' }] })
        const generated = {
            ...input,
            message: [...input.message, { role: 'char', data: 'result', chatId: 'generated-1' }],
        }
        const calls: string[] = []
        const harness = createServiceHarness(input, {
            getGenerationWorkflowInputChat: () => input,
            publishChatCommitted: vi.fn(() => { calls.push('publish') }),
        })
        harness.persistChat.mockImplementationOnce(async ({ chat, expectedEtag }: any) => {
            calls.push('persist')
            return harness.store.commitChat('character-1', 'room-1', chat, expectedEtag)
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

        expect(result.chat).toEqual(generated)
        expect(harness.stored()).toEqual(generated)
        expect(calls).toEqual(['persist', 'finalize', 'publish'])
    })

    it('rejects a commit when the durable row changed after it was read', async () => {
        const base = room({ note: 'before' })
        let store: any
        const harness = createServiceHarness(base, {
            loadChat: async (characterId: string, chatId: string) => {
                const state = store.getChatState(characterId, chatId)
                store.commitChat(characterId, chatId, { ...state.chat, note: 'other device' }, state.etag)
                return state
            },
        })
        store = harness.store

        await expect(harness.service.commitUserDelta({
            characterId: 'character-1',
            chatId: 'room-1',
            changes: createDelta(base, { ...base, note: 'mine' }),
        })).rejects.toMatchObject({ httpStatus: 409, code: 'CHAT_CONTENT_CHANGED' })
        expect(harness.stored().note).toBe('other device')
        expect(harness.publishChatCommitted).not.toHaveBeenCalled()
    })

    it('keeps a conflicting generation uncommitted until the exact compared values are resolved', async () => {
        const input = room({ scriptstate: { $score: '10', $mood: 'neutral' } })
        const current = { ...input, scriptstate: { $score: '20', $mood: 'angry', $display: 'light' } }
        const generated = { ...input, scriptstate: { $score: '13', $mood: 'happy' }, message: [
            { role: 'char', data: 'answer', chatId: 'generated-1' },
        ] }
        const harness = createServiceHarness(current, { getGenerationWorkflowInputChat: () => input })
        const workflow: any = {
            workflowId: 'workflow-1',
            context: { postprocess: { chatPatch: [], character: {}, messageChatId: 'generated-1' } },
            steps: [{ key: 'message.materialize', metadata: {} }],
        }
        const finalize = vi.fn()
        const commit = () => harness.service.commitGenerationResult({
            job: { characterId: 'character-1', roomId: 'room-1' }, workflow, chat: generated, finalize,
        })
        const conflict = await commit().catch((error: any) => error)
        expect(conflict).toMatchObject({ httpStatus: 409, conflicts: ['/scriptstate/$score', '/scriptstate/$mood'], action: { kind: 'ui.resolve-conflict' } })
        expect(harness.persistChat).not.toHaveBeenCalled()
        expect(finalize).not.toHaveBeenCalled()

        workflow.steps[0].metadata.responses = { [conflict.action.actionId]: ['local', 'server'] }
        harness.replaceStored({ ...current, scriptstate: { ...current.scriptstate, $score: '30' } })
        const changed = await commit().catch((error: any) => error)
        expect(changed).toMatchObject({ httpStatus: 409, action: { kind: 'ui.resolve-conflict' } })
        expect(harness.persistChat).not.toHaveBeenCalled()

        workflow.steps[0].metadata.responses[changed.action.actionId] = ['local', 'server']
        const resolved = await commit()
        expect(resolved.chat).toMatchObject({ scriptstate: { $score: '13', $mood: 'angry', $display: 'light' }, message: generated.message })
        expect(finalize).toHaveBeenCalledOnce()
        expect(harness.publishChatCommitted).toHaveBeenCalledOnce()
    })
})

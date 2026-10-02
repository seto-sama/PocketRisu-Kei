// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from './database.svelte'
import { get } from 'svelte/store'
import { ConflictError } from './storageRequest'
import { saveConflictDialog, SaveConflictCancelledError } from './saveConflict'
import { applyDelta, valuesEqual, DeltaConflictError } from '../../../shared/guardedDelta.mjs'

const backend = vi.hoisted(() => ({
    chat: undefined as Chat | undefined,
    version: 0,
    beforeSave: undefined as (() => Promise<void>) | undefined,
    beforeFetch: undefined as (() => Promise<void>) | undefined,
    realStorage: {
        fetchChatState: vi.fn(),
        patchChatContent: vi.fn(),
        getChatEtag: vi.fn(),
    },
}))
vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: backend.realStorage } }))
vi.mock('./database.svelte', () => ({ isChatStub: () => false }))

const { discardPendingChatSaves, fetchChatFromServer, getFetchedChatState, saveChatToServer } = await import('./chatStorage')
const {
    discardAllChatWorkingCopies,
    discardAllChatGenerationProjections,
    isChatWorkingCopyDirty,
    markChatWorkingCopyDirty,
} = await import('./chatWorkingCopy')

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
}

const makeChat = () => ({
    id: 'room',
    note: '',
    name: 'Room',
    localLore: [],
    message: [
        { chatId: 'old', role: 'user', data: 'old message' },
        { chatId: 'keep', role: 'char', data: 'keep this' },
    ],
    savedToggleValues: { toggle_prompt: 'A' },
}) as Chat

beforeEach(() => {
    discardAllChatWorkingCopies()
    discardPendingChatSaves()
    discardAllChatGenerationProjections()
    backend.chat = makeChat()
    backend.version = 0
    backend.beforeSave = undefined
    backend.beforeFetch = undefined
    backend.realStorage.getChatEtag.mockReset().mockImplementation(() => `etag-${backend.version}`)
    backend.realStorage.fetchChatState.mockReset().mockImplementation(async () => {
        await backend.beforeFetch?.()
        return { chat: structuredClone(backend.chat), etag: `etag-${backend.version}` }
    })
    backend.realStorage.patchChatContent.mockReset().mockImplementation(async (
        _characterId, _index, _chatId, request,
    ) => {
        await backend.beforeSave?.()
        try {
            const next = applyDelta(backend.chat, request.changes)
            if (!valuesEqual(next, backend.chat)) backend.version++
            backend.chat = next
            return { etag: `etag-${backend.version}` }
        } catch (error) {
            if (error instanceof DeltaConflictError) throw new ConflictError('Chat content changed', `etag-${backend.version}`)
            throw error
        }
    })
})

describe('guarded chat saves', () => {
    it('saves the final toggle value when edits arrive during an earlier save', async () => {
        const live = await fetchChatFromServer('character', 0, 'room')
        for (const value of ['B', 'C']) {
            live.savedToggleValues.toggle_prompt = value
            markChatWorkingCopyDirty('character', 'room', 'etag-0')
        }
        const gate = deferred()
        backend.beforeSave = () => gate.promise
        const first = saveChatToServer('character', 0, 'room', live)
        await vi.waitFor(() => expect(backend.realStorage.patchChatContent).toHaveBeenCalledTimes(1))
        live.savedToggleValues.toggle_prompt = 'B'
        markChatWorkingCopyDirty('character', 'room', 'etag-0')
        const last = saveChatToServer('character', 0, 'room', live)
        gate.resolve()
        await Promise.all([first, last])

        expect(backend.chat.savedToggleValues.toggle_prompt).toBe('B')
        expect(backend.realStorage.fetchChatState).toHaveBeenCalledTimes(1)
        expect(backend.realStorage.patchChatContent).toHaveBeenCalledTimes(2)
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(false)
    })

    it('keeps a deletion alongside an image committed immediately before the patch', async () => {
        const live = await fetchChatFromServer('character', 0, 'room')
        live.message.shift()
        markChatWorkingCopyDirty('character', 'room', 'etag-0')
        backend.beforeSave = async () => {
            backend.chat.message.push({ chatId: 'image', role: 'char', kind: 'imageGeneration', data: 'new image' })
            backend.version++
            backend.beforeSave = undefined
        }
        await saveChatToServer('character', 0, 'room', live)
        expect(backend.chat.message.map(message => message.chatId)).toEqual(['keep', 'image'])
        expect(backend.realStorage.fetchChatState).toHaveBeenCalledTimes(1)
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(false)

        live.note = 'another edit'
        markChatWorkingCopyDirty('character', 'room', `etag-${backend.version}`)
        await saveChatToServer('character', 0, 'room', live)
        expect(backend.chat.note).toBe('another edit')
        expect(backend.chat.message.map(message => message.chatId)).toEqual(['keep', 'image'])
    })

    it('settles a lost acknowledgement before sending the next toggle value', async () => {
        const live = await fetchChatFromServer('character', 0, 'room')
        live.savedToggleValues.toggle_prompt = 'C'
        markChatWorkingCopyDirty('character', 'room', 'etag-0')
        const send = backend.realStorage.patchChatContent.getMockImplementation()!
        backend.realStorage.patchChatContent.mockImplementationOnce(async (...args) => {
            await send(...args)
            throw new TypeError('Failed to fetch')
        })
        await expect(saveChatToServer('character', 0, 'room', live)).rejects.toThrow('Failed to fetch')
        expect(backend.chat.savedToggleValues.toggle_prompt).toBe('C')

        live.savedToggleValues.toggle_prompt = 'B'
        markChatWorkingCopyDirty('character', 'room', 'etag-0')
        await saveChatToServer('character', 0, 'room', live)
        expect(backend.chat.savedToggleValues.toggle_prompt).toBe('B')
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(false)
    })

    it('does not adopt an older fetch baseline after a save has acknowledged', async () => {
        const live = await fetchChatFromServer('character', 0, 'room')
        const old = { chat: structuredClone(backend.chat), etag: 'etag-0' }
        const gate = deferred()
        backend.realStorage.fetchChatState.mockImplementationOnce(async () => { await gate.promise; return old })
        const fetching = fetchChatFromServer('character', 0, 'room')
        live.savedToggleValues.toggle_prompt = 'B'
        markChatWorkingCopyDirty('character', 'room', 'etag-0')
        await saveChatToServer('character', 0, 'room', live)
        gate.resolve()
        await fetching

        live.savedToggleValues.toggle_prompt = 'C'
        markChatWorkingCopyDirty('character', 'room', `etag-${backend.version}`)
        await saveChatToServer('character', 0, 'room', live)
        expect(backend.chat.savedToggleValues.toggle_prompt).toBe('C')
    })

    it('keeps the newer baseline when overlapping read responses arrive out of order', async () => {
        const gate = deferred()
        const old = { chat: structuredClone(backend.chat), etag: 'etag-0' }
        backend.realStorage.fetchChatState.mockImplementationOnce(async () => { await gate.promise; return old })
        const first = fetchChatFromServer('character', 0, 'room')
        await vi.waitFor(() => expect(backend.realStorage.fetchChatState).toHaveBeenCalledOnce())
        backend.chat.savedToggleValues.toggle_prompt = 'C'
        backend.version++
        const live = await fetchChatFromServer('character', 0, 'room')
        expect(backend.realStorage.fetchChatState).toHaveBeenCalledTimes(2)
        gate.resolve()
        const older = await first
        expect(getFetchedChatState(older).isCurrent()).toBe(false)
        expect(getFetchedChatState(live).isCurrent()).toBe(true)
        live.savedToggleValues.toggle_prompt = 'B'
        markChatWorkingCopyDirty('character', 'room', 'etag-1')
        await saveChatToServer('character', 0, 'room', live)
        expect(backend.chat.savedToggleValues.toggle_prompt).toBe('B')
    })

    it('saves the final bound toggle value alongside an unrelated server edit', async () => {
        const live = await fetchChatFromServer('character', 0, 'room')
        for (const value of ['B', 'C', 'B']) {
            live.savedToggleValues.toggle_prompt = value
            markChatWorkingCopyDirty('character', 'room', 'etag-0')
        }
        backend.chat.note = 'server update'
        backend.version++
        await saveChatToServer('character', 0, 'room', live)
        expect(backend.chat.savedToggleValues.toggle_prompt).toBe('B')
        expect(backend.chat.note).toBe('server update')

        live.savedToggleValues.toggle_prompt = 'D'
        markChatWorkingCopyDirty('character', 'room', `etag-${backend.version}`)
        await saveChatToServer('character', 0, 'room', live)
        expect(backend.chat.savedToggleValues.toggle_prompt).toBe('D')
        expect(backend.chat.note).toBe('server update')
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(false)
    })

    it('rechecks the current chat after waiting in the save queue', async () => {
        let live = await fetchChatFromServer('character', 0, 'room')
        live.note = 'user edit'
        markChatWorkingCopyDirty('character', 'room', 'etag-0')
        const gate = deferred()
        backend.beforeSave = () => gate.promise
        const first = saveChatToServer('character', 0, 'room', live)
        await vi.waitFor(() => expect(backend.realStorage.patchChatContent).toHaveBeenCalledTimes(1))
        const queued = saveChatToServer('character', 0, 'room', live, {
            tracked: true, getChat: () => live,
        })
        live = { ...structuredClone(live), message: [], isStreaming: true }
        gate.resolve()
        await Promise.all([first, queued])

        expect(backend.realStorage.patchChatContent).toHaveBeenCalledTimes(1)
        expect(backend.chat.message).toHaveLength(2)
    })

    it('keeps both versions and the local dirty state when conflict resolution is cancelled', async () => {
        const live = await fetchChatFromServer('character', 0, 'room')
        live.message[0].data = 'local edit'
        markChatWorkingCopyDirty('character', 'room', 'etag-0')
        backend.chat.message[0].data = 'remote edit'
        backend.version++

        const saving = saveChatToServer('character', 0, 'room', live)
        await vi.waitFor(() => expect(get(saveConflictDialog)).not.toBeNull())
        const dialog = get(saveConflictDialog)!
        expect(dialog.items[0].local.data).toBe('local edit')
        expect(dialog.items[0].server.data).toBe('remote edit')
        const cancelled = expect(saving).rejects.toBeInstanceOf(SaveConflictCancelledError)
        dialog.complete(null)
        await cancelled
        expect(backend.chat.message[0].data).toBe('remote edit')
        expect(live.message[0].data).toBe('local edit')
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(true)
        expect(backend.realStorage.patchChatContent).toHaveBeenCalledTimes(1)
    })

    it('uses the selected server message while saving unrelated local edits and retaining server additions', async () => {
        const live = await fetchChatFromServer('character', 0, 'room')
        live.message[0].data = 'my edit'
        live.note = 'my note'
        markChatWorkingCopyDirty('character', 'room')
        backend.chat.message[0].data = 'server edit'
        backend.chat.message.push({ chatId: 'image', role: 'char', data: 'generated image' })
        const saving = saveChatToServer('character', 0, 'room', live)
        await vi.waitFor(() => expect(get(saveConflictDialog)).not.toBeNull())
        get(saveConflictDialog)!.complete(['server'])
        await saving
        expect(backend.chat.message[0].data).toBe('server edit')
        expect(backend.chat.message.at(-1).chatId).toBe('image')
        expect(backend.chat.note).toBe('my note')
        expect(live.message).toEqual(backend.chat.message)
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(false)
    })

    it('compares again if the server changes while the dialog is open', async () => {
        const live = await fetchChatFromServer('character', 0, 'room')
        live.message[0].data = 'my edit'
        markChatWorkingCopyDirty('character', 'room')
        backend.chat.message[0].data = 'first server edit'
        const saving = saveChatToServer('character', 0, 'room', live)
        await vi.waitFor(() => expect(get(saveConflictDialog)).not.toBeNull())
        const first = get(saveConflictDialog)!
        backend.chat.message[0].data = 'second server edit'
        first.complete(['local'])
        await vi.waitFor(() => {
            expect(get(saveConflictDialog)).not.toBeNull()
            expect(get(saveConflictDialog)).not.toBe(first)
        })
        expect(get(saveConflictDialog)!.items[0].server.data).toBe('second server edit')
        get(saveConflictDialog)!.complete(['local'])
        await saving
        expect(backend.chat.message[0].data).toBe('my edit')
        expect(backend.realStorage.patchChatContent).toHaveBeenCalledTimes(3)
        expect(isChatWorkingCopyDirty('character', 'room')).toBe(false)
    })
})

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyDelta } from '../../shared/guardedDelta.mjs'

const state = vi.hoisted(() => ({
    chat: undefined as any,
    etag: 0,
    fetchChatState: vi.fn(),
    getChatEtag: vi.fn(),
    patchChatContent: vi.fn(),
    reconcileServerDatabase: vi.fn(),
    socketInstances: [] as any[],
}))

vi.mock('./storage/autoStorage', () => ({
    forageStorage: {
        createAuth: vi.fn(async () => 'auth'),
        realStorage: {
            fetchChatState: state.fetchChatState,
            getChatEtag: state.getChatEtag,
            patchChatContent: state.patchChatContent,
        },
    },
}))
vi.mock('./storage/database.svelte', () => ({ isChatStub: () => false }))
vi.mock('./storage/nodeStorage', () => ({ getSyncClientId: () => 'client' }))
vi.mock('./sync/databaseSync', () => ({
    reconcileServerDatabase: state.reconcileServerDatabase,
    syncChatKey: (characterId: string, chatId: string) => `${characterId}\u0000${chatId}`,
}))
vi.mock('./bookmarks/bookmarkService', () => ({ refreshBookmarkCatalog: vi.fn() }))
vi.mock('./process/revenant/jobStatus', () => ({ finishRevenantWorkflowRequestStatuses: vi.fn() }))
vi.mock('./process/revenant/workflow', () => ({
    emitRevenantWorkflowSyncReady: vi.fn(),
    emitRevenantWorkflowUpdate: vi.fn(),
}))

const { discardPendingChatSaves, fetchChatFromServer, saveChatToServer } = await import('./storage/chatStorage')
const { discardAllChatWorkingCopies } = await import('./storage/chatWorkingCopy')
const { startSyncReceiver } = await import('./syncReceiver.svelte')

class MockWebSocket {
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: (() => void) | null = null

    constructor() {
        state.socketInstances.push(this)
    }

    close() {}

    receive(data: unknown) {
        this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
    }
}

beforeEach(() => {
    state.chat = {
        id: 'room',
        name: 'Room',
        note: '',
        localLore: [{
            key: 'saved lore', secondkey: '', insertorder: 1000, comment: '', content: 'before',
            mode: 'normal', alwaysActive: false, selective: false,
        }],
        message: [{ chatId: 'message', role: 'user', data: 'hello' }],
    }
    state.etag = 0
    state.socketInstances.length = 0
    state.fetchChatState.mockReset().mockImplementation(async () => ({
        chat: structuredClone(state.chat),
        etag: `etag-${state.etag}`,
    }))
    state.getChatEtag.mockReset().mockImplementation(() => `etag-${state.etag}`)
    state.patchChatContent.mockReset().mockImplementation(async (_characterId, _index, _chatId, request) => {
        state.chat = applyDelta(state.chat, request.changes)
        state.etag++
        return { etag: `etag-${state.etag}` }
    })
    state.reconcileServerDatabase.mockReset().mockResolvedValue(undefined)
    discardPendingChatSaves()
    discardAllChatWorkingCopies()
    vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

it('saves lorebook edits without reconciling, while external invalidations still reconcile', async () => {
    vi.useFakeTimers()
    const stop = startSyncReceiver()
    try {
        await vi.waitFor(() => expect(state.socketInstances).toHaveLength(1))
        const live = await fetchChatFromServer('character', 0, 'room')
        expect(live).not.toBeNull()

        const lore = live!.localLore[0]
        lore.content = 'after'
        await saveChatToServer('character', 0, 'room', live!)

        expect(state.chat.localLore[0].content).toBe('after')
        expect(state.fetchChatState).toHaveBeenCalledTimes(1)
        await vi.runAllTimersAsync()
        expect(state.reconcileServerDatabase).not.toHaveBeenCalled()

        state.socketInstances[0].receive({
            type: 'database-invalidated',
            chats: [{ characterId: 'character', chatId: 'room' }],
        })
        await vi.runAllTimersAsync()

        expect(state.reconcileServerDatabase).toHaveBeenCalledOnce()
        expect(state.reconcileServerDatabase).toHaveBeenCalledWith(
            new Set(['character\u0000room']), false, new Set(),
        )
    } finally {
        stop()
    }
})

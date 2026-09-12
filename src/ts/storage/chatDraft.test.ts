import { describe, test, expect, vi, beforeEach } from 'vitest'

// In-memory forage stub. `setItemDelay` lets a save be made slower than a
// following remove (so the ordering test fails loudly if writes ever run
// concurrently again); `setItemThrowsAfterStore` simulates a write the server
// commits but whose response is lost.
const { mockStore, mockState } = vi.hoisted(() => ({
    mockStore: new Map<string, Uint8Array>(),
    mockState: {
        setItemGate: null as Promise<void> | null,
        onSetItem: null as (() => void) | null,
        setItemThrowsAfterStore: false,
    },
}))

vi.mock('./autoStorage', () => ({
    forageStorage: {
        async keys(prefix = '') {
            return [...mockStore.keys()].filter((k) => k.startsWith(prefix))
        },
        async setItem(key: string, value: Uint8Array) {
            mockState.onSetItem?.()
            if (mockState.setItemGate) await mockState.setItemGate
            mockStore.set(key, value) // server commits
            if (mockState.setItemThrowsAfterStore) throw new Error('response lost') // ...but the response is dropped
        },
        async getItem(key: string) {
            return mockStore.get(key) ?? null
        },
        async removeItem(key: string) {
            mockStore.delete(key)
        },
    },
}))

const {
    loadChatDraft,
    flushChatDraft,
    removeChatDraft,
    sweepOrphanDrafts,
    chatDraftKey,
} = await import('./chatDraft')

beforeEach(() => {
    mockStore.clear()
    mockState.setItemGate = null
    mockState.onSetItem = null
    mockState.setItemThrowsAfterStore = false
})

// Each test uses a distinct character id so the module-level index cannot leak
// between cases.

describe('chatDraft write ordering', () => {
    test('a delayed save cannot resurrect a draft a later remove deleted', async () => {
        let releaseSave!: () => void
        let markSaveStarted!: () => void
        mockState.setItemGate = new Promise((resolve) => { releaseSave = resolve })
        const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve })
        mockState.onSetItem = markSaveStarted

        void flushChatDraft('ser', 'c1', { m: 'hello' })
        await saveStarted
        const remove = removeChatDraft('ser', 'c1')
        releaseSave()
        await remove
        const loaded = await loadChatDraft('ser', 'c1') // drains the queue, then reads
        expect(loaded).toBeNull()
        expect(mockStore.has(chatDraftKey('ser', 'c1'))).toBe(false)
    })

    test('a sent chat can still hold a new draft afterwards', async () => {
        void flushChatDraft('ser2', 'c1', { m: 'first' })
        void removeChatDraft('ser2', 'c1') // message sent
        void flushChatDraft('ser2', 'c1', { m: 'second' }) // user types again
        const loaded = await loadChatDraft('ser2', 'c1')
        expect(loaded).toEqual({ m: 'second' })
    })

    test('send removes a draft whose save response was lost (server has it, index does not)', async () => {
        mockState.setItemThrowsAfterStore = true
        await flushChatDraft('lost', 'c1', { m: 'sent text' }) // server stores it, response dropped
        mockState.setItemThrowsAfterStore = false
        expect(mockStore.has(chatDraftKey('lost', 'c1'))).toBe(true) // stale draft sits on the server
        await removeChatDraft('lost', 'c1') // sent: must remove despite the missing index entry
        expect(mockStore.has(chatDraftKey('lost', 'c1'))).toBe(false)
    })
})

describe('sweepOrphanDrafts', () => {
    test('removes drafts whose chat is gone, keeps existing ones', async () => {
        void flushChatDraft('keep', 'c1', { m: 'still here' })
        void flushChatDraft('gone', 'c1', { m: 'orphan' })
        await loadChatDraft('keep', 'c1') // drain the saves
        await sweepOrphanDrafts(new Set([chatDraftKey('keep', 'c1')]))
        await loadChatDraft('keep', 'c1') // drain the sweep removes
        expect(mockStore.has(chatDraftKey('keep', 'c1'))).toBe(true)
        expect(mockStore.has(chatDraftKey('gone', 'c1'))).toBe(false)
    })
})

describe('chatDraft round trip', () => {
    test('load returns a saved draft', async () => {
        void flushChatDraft('load', 'c1', { m: 'remember me' })
        const loaded = await loadChatDraft('load', 'c1')
        expect(loaded).toEqual({ m: 'remember me' })
    })

})

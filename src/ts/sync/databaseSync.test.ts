import { beforeEach, expect, it, vi } from 'vitest'
import { applyDelta, DeltaConflictError } from '../../../shared/guardedDelta.mjs'

const state = vi.hoisted(() => ({ database: { characters: [] } as any, fetchChatState: vi.fn() }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => state.database, isChatStub: () => false }))
vi.mock('../storage/autoStorage', () => ({ forageStorage: { realStorage: { fetchChatState: state.fetchChatState } } }))

import { reconcileHydratedChats } from './databaseSync'
import { fetchChatFromServer, getFetchedChatState } from '../storage/chatStorage'
import {
    acknowledgeChatCommit, createChatCommitSnapshot, discardAllChatWorkingCopies,
    discardAllChatGenerationProjections, markChatWorkingCopyDirty, pruneChatServerStates,
    recordChatServerState,
} from '../storage/chatWorkingCopy'

const chat = () => ({
    id: 'room', name: 'Room', note: '', localLore: [],
    message: [{ chatId: 'message', role: 'user', data: 'original' }],
}) as any
const database = (body: any) => ({ characters: [{ chaId: 'character', chats: [body] }] }) as any

beforeEach(() => {
    discardAllChatWorkingCopies()
    discardAllChatGenerationProjections()
    pruneChatServerStates([])
    state.fetchChatState.mockReset()
})

it('preserves pending edits and their original conflict guards when installing a fetched body', async () => {
    const base = chat()
    recordChatServerState('character', base, 'base')
    const remote = structuredClone(base)
    remote.message[0].role = 'char'
    remote.message.push({ chatId: 'image', role: 'char', data: 'new image' })
    const live = structuredClone(base)
    live.message[0].data = 'edited after fetch'
    state.database = database(live)
    markChatWorkingCopyDirty('character', 'room', 'base')
    state.fetchChatState.mockResolvedValueOnce({ chat: remote, etag: 'remote' })
    const fetched = await fetchChatFromServer('character', 0, 'room')

    const incoming = database(fetched)
    reconcileHydratedChats(incoming, [{ characterId: 'character', chatId: 'room', read: getFetchedChatState(fetched) }])
    const merged = incoming.characters[0].chats[0]
    expect(merged.message).toEqual([live.message[0], remote.message[1]])
    expect(() => applyDelta(remote, createChatCommitSnapshot('character', merged).changes))
        .toThrow(DeltaConflictError)
})

it('keeps a newer acknowledged save when an older fetched body arrives', async () => {
    const base = chat()
    recordChatServerState('character', base, 'base')
    state.fetchChatState.mockResolvedValueOnce({ chat: base, etag: 'base' })
    const fetched = await fetchChatFromServer('character', 0, 'room')
    const read = getFetchedChatState(fetched)
    const live = { ...base, note: 'saved while fetching' }
    state.database = database(live)
    markChatWorkingCopyDirty('character', 'room', 'base')
    acknowledgeChatCommit(createChatCommitSnapshot('character', live), 'saved')
    const refresh = vi.fn()
    window.addEventListener('risu-sync-refresh-requested', refresh)
    try {
        const incoming = database(fetched)
        reconcileHydratedChats(incoming, [{ characterId: 'character', chatId: 'room', read, terminalCanonical: true }])
        expect(incoming.characters[0].chats[0].note).toBe('saved while fetching')
        expect(refresh).toHaveBeenCalledOnce()
        expect(refresh.mock.calls[0][0].detail.terminalCanonical).toBe(true)
    } finally {
        window.removeEventListener('risu-sync-refresh-requested', refresh)
    }
})

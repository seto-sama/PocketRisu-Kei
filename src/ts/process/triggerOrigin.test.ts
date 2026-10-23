import { beforeEach, expect, it, vi } from 'vitest'
import { isChatWorkingCopyDirty } from '../storage/chatWorkingCopy'

const state = vi.hoisted(() => ({ db: { characters: [] as any[] }, saved: [] as any[] }))
vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => state.db,
    normalizeChat: (chat: unknown) => chat,
}))
vi.mock('../globalApi.svelte', () => ({
    requestImmediateSave: async (options: unknown) => { state.saved.push(options) },
}))

import { commitTriggerChat } from './triggerOrigin'

beforeEach(() => { state.saved = [] })

it('finds a reordered origin chat and queues its save independently of the visible chat', async () => {
    state.db.characters = [{ chaId: 'origin', chats: [
        { id: 'other', message: [{ data: 'untouched' }] },
        { id: 'chat', message: [{ data: 'before' }] },
    ] }]
    const target = { characterId: 'origin', chatId: 'chat' }
    await expect(commitTriggerChat(target, { id: 'chat', message: [{ data: 'after' }] } as never)).resolves.toBe(true)
    expect(state.db.characters[0].chats.map((chat: any) => chat.message[0].data)).toEqual(['untouched', 'after'])
    expect(isChatWorkingCopyDirty('origin', 'chat')).toBe(true)
    expect(state.saved).toEqual([{ characterIds: ['origin'], chatTargets: [target] }])
})

it('does not restore a deleted trigger target or save over a different chat', async () => {
    state.db.characters = [{ chaId: 'origin', chats: [{ id: 'other', message: [] }] }]
    await expect(commitTriggerChat({ characterId: 'origin', chatId: 'deleted' }, { message: [] } as never)).resolves.toBe(false)
    expect(state.db.characters[0].chats).toEqual([{ id: 'other', message: [] }])
    expect(state.saved).toEqual([])
})

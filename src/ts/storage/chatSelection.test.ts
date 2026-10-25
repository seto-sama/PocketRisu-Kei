import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
})

const character = (ids = ['a', 'b', 'c']) => ({
    chaId: 'character', name: 'Name', chats: ids.map(id => ({ id })),
})

describe('device chat selection', () => {
    it('restores the selected chat after a reload and follows it through reordering', async () => {
        const { setChatPage } = await import('./chatSelection.svelte')
        setChatPage(character(), 1)

        vi.resetModules()
        const { getChatPage, initializeChatSelection } = await import('./chatSelection.svelte')
        const reloaded = character(['c', 'a', 'b'])
        initializeChatSelection(reloaded)
        expect(reloaded.chats[getChatPage(reloaded)].id).toBe('b')
    })

    it('migrates legacy selection without overriding the device selection on later loads', async () => {
        const { getChatPage, initializeChatSelection } = await import('./chatSelection.svelte')
        const imported = { ...character(), chatPage: 1 }
        initializeChatSelection(imported)
        expect(getChatPage(imported)).toBe(1)
        expect(imported).not.toHaveProperty('chatPage')

        const server = { ...character(), chatPage: 0 }
        initializeChatSelection(server)
        expect(getChatPage(server)).toBe(1)
        expect(server).not.toHaveProperty('chatPage')
    })

    it('falls back to an available chat when the selected room is removed', async () => {
        const { getChatPage, setChatPage, initializeChatSelection } = await import('./chatSelection.svelte')
        setChatPage(character(), 2)
        const remaining = character(['a'])
        initializeChatSelection(remaining)
        expect(remaining.chats[getChatPage(remaining)].id).toBe('a')
        expect(getChatPage(character([]))).toBe(0)
    })

    it('applies the selected chat from a plugin snapshot without storing chatPage', async () => {
        const { getChatPage, initializeChatSelection, setChatPage, withChatSelection } = await import('./chatSelection.svelte')
        const original = character()
        setChatPage(original, 1)
        const snapshot = withChatSelection(original)
        expect(snapshot.chatPage).toBe(1)
        snapshot.chatPage = 2
        initializeChatSelection(snapshot, true)
        expect(getChatPage(original)).toBe(2)
        expect(snapshot).not.toHaveProperty('chatPage')
    })
})

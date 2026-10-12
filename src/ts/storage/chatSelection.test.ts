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

    it('preserves legacy plugin reads, edits and serialized output without storing chatPage', async () => {
        const { getChatPage, initializeChatSelection, pluginCharacterSelections, withChatSelection } = await import('./chatSelection.svelte')
        const original = character()
        const characters = [original]
        const legacy = pluginCharacterSelections(characters) as Array<typeof original & { chatPage: number }>
        legacy[0].chatPage = 1
        legacy[0].name = 'Plugin edit'
        expect(original.name).toBe('Plugin edit')
        expect(withChatSelection(original).chatPage).toBe(1)
        expect(JSON.parse(JSON.stringify(legacy))[0]).toEqual({ ...original, chatPage: 1 })
        expect(original).not.toHaveProperty('chatPage')

        const snapshot = withChatSelection(original)
        snapshot.chatPage = 2
        initializeChatSelection(snapshot, true)
        expect(getChatPage(original)).toBe(2)
        expect(snapshot).not.toHaveProperty('chatPage')
    })
})

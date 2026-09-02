import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    changeChar: vi.fn(),
    changeChatTo: vi.fn(),
    requestMessageScroll: vi.fn(),
    clearMessageScrollRequest: vi.fn(),
    db: {
        characters: [{
            chaId: 'character-1',
            chatPage: 0,
            chats: [{
                id: 'room-1',
                message: [{ chatId: 'message-1', role: 'char', data: 'hello' }],
            }],
        }],
    },
}))

const selectedCharID = writable(-1)

vi.mock('./characters', () => ({ changeChar: mocks.changeChar }))
vi.mock('./globalApi.svelte', () => ({ changeChatTo: mocks.changeChatTo }))
vi.mock('./stores.svelte', () => ({
    DBState: { db: mocks.db },
    selectedCharID,
    requestMessageScroll: mocks.requestMessageScroll,
    clearMessageScrollRequest: mocks.clearMessageScrollRequest,
}))

const { navigateToChatMessage } = await import('./chatMessageNavigation')

describe('shared chat message navigation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        selectedCharID.set(-1)
        mocks.db.characters[0].chatPage = 0
    })

    it('queues a room-identified request before activating another character', () => {
        expect(navigateToChatMessage({
            characterIndex: 0,
            chatIndex: 0,
            messageIndex: 0,
            exact: false,
        })).toBe(true)

        expect(mocks.requestMessageScroll).toHaveBeenCalledWith({
            index: 0,
            exact: false,
            characterId: 'character-1',
            chatId: 'room-1',
            messageId: 'message-1',
        })
        expect(mocks.requestMessageScroll.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.changeChar.mock.invocationCallOrder[0],
        )
        expect(mocks.changeChar).toHaveBeenCalledWith(0)
        expect(mocks.changeChatTo).not.toHaveBeenCalled()
    })

    it('switches only the room when its character is already active', () => {
        selectedCharID.set(0)
        mocks.db.characters[0].chats.push({
            id: 'room-2',
            message: [{ chatId: 'message-2', role: 'char', data: 'second' }],
        } as never)

        navigateToChatMessage({ characterIndex: 0, chatIndex: 1, messageIndex: 0 })

        expect(mocks.changeChar).not.toHaveBeenCalled()
        expect(mocks.changeChatTo).toHaveBeenCalledWith(1)
        mocks.db.characters[0].chats.pop()
    })
})

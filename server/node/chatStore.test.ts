// @vitest-environment node
import { describe, expect, it } from 'vitest'
import chatStorePkg from './chatStore.cjs'

const {
    computeChatEtag,
    createFullChatStore,
    commitChatContent,
    stripChatsFromDb,
    reassembleFullDb,
    findStubFlagLossChats,
} = chatStorePkg as any

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

    it('reports metadata-only chats that lost their stub marker', () => {
        const malformed = {
            characters: [{ chaId: 'character', chats: [{ id: 'room', name: 'Room' }] }],
        }

        expect(findStubFlagLossChats(malformed)).toEqual([{
            chaId: 'character', charIndex: 0, chatIndex: 0, chatId: 'room',
        }])
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

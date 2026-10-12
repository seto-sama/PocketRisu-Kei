import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDelta } from '../../../../shared/guardedDelta.mjs'
import type { Chat, Database } from 'src/ts/storage/database.svelte'

const storage = vi.hoisted(() => ({
    fetchChatState: vi.fn(),
    patchChatContent: vi.fn(),
    getChatEtag: vi.fn(() => 'base'),
}))

vi.mock('src/ts/storage/autoStorage', () => ({ forageStorage: { realStorage: storage } }))
vi.mock('src/ts/globalApi.svelte', () => ({ downloadFile: () => {}, saveAsset: async () => '' }))
vi.mock('src/ts/characters', () => ({ createBlankChar: () => ({}), getCharImage: () => '' }))
vi.mock('src/ts/alert', () => ({ notifySuccess: vi.fn(), alertError: vi.fn() }))

const { DBState, selectedCharID } = await import('src/ts/stores.svelte')
const { cloneChatValue, discardAllChatWorkingCopies, isChatWorkingCopyDirty } = await import('src/ts/storage/chatWorkingCopy')
const { getChatFromIndex, setChatToIndex } = await import('./chatAccess.svelte')
const { setChatPage } = await import('src/ts/storage/chatSelection.svelte')

let serverChat: Chat

beforeEach(() => {
    vi.clearAllMocks()
    discardAllChatWorkingCopies()
    selectedCharID.set(0)
    serverChat = {
        id: 'unopened', name: 'Unopened', note: '', localLore: [],
        message: [{ chatId: 'message', role: 'user', data: 'Server body' }],
    }
    DBState.db = {
        characters: [{ chaId: 'character', chats: [
            { ...serverChat, id: 'open', name: 'Open' },
            { id: serverChat.id, name: serverChat.name, message: [], _placeholder: true },
        ] }],
    } as unknown as Database
    setChatPage(DBState.db.characters[0], 0)
    storage.fetchChatState.mockImplementation(async () => ({
        chat: structuredClone(serverChat), etag: 'base',
    }))
    storage.patchChatContent.mockImplementation(async (_characterId, _index, _chatId, request) => {
        serverChat = applyDelta(serverChat, request.changes) as Chat
        return { etag: 'saved' }
    })
})

describe('V3 plugin chat access', () => {
    it('treats the locally selected room as open when a plugin edits it', async () => {
        const character = DBState.db.characters[0]
        setChatPage(character, 1)
        await setChatToIndex(0, 1, { ...serverChat, note: 'Plugin edit' })
        expect(character.chats[1].note).toBe('Plugin edit')
        expect(storage.patchChatContent).not.toHaveBeenCalled()
    })

    it('returns full unopened chats without hydrating the list, and snapshots loaded chats', async () => {
        const full = await getChatFromIndex(0, 1)
        expect(full?.message[0].data).toBe('Server body')
        const placeholder = DBState.db.characters[0].chats[1]
        expect(placeholder._placeholder).toBe(true)
        expect(placeholder.message).toEqual([])

        const loaded = await getChatFromIndex(0, 0)
        loaded!.message[0].data = 'Plugin copy'
        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('Server body')
        expect(await getChatFromIndex(0, 99)).toBeNull()
    })

    it.each([
        { name: 'placeholder', payload: { _placeholder: true, message: [] } },
        { name: 'different-id', payload: { id: 'different', message: [] } },
    ])('rejects $name writes without changing the slot', async ({ payload }) => {
        const before = cloneChatValue(DBState.db.characters[0].chats[1])
        await expect(setChatToIndex(0, 1, payload)).rejects.toThrow()
        expect(DBState.db.characters[0].chats[1]).toEqual(before)
        expect(storage.patchChatContent).not.toHaveBeenCalled()
    })

    it('preserves the slot id and awaits inactive persistence even when lists and selection change', async () => {
        const full = (await getChatFromIndex(0, 1))!
        delete full.id
        full.message[0].data = 'Plugin edit'
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        storage.patchChatContent.mockImplementationOnce(async (characterId, _index, chatId, request) => {
            expect(characterId).toBe('character')
            expect(chatId).toBe('unopened')
            await gate
            serverChat = applyDelta(serverChat, request.changes) as Chat
            return { etag: 'saved' }
        })
        let complete = false
        const save = setChatToIndex(0, 1, full).then(() => { complete = true })
        const character = DBState.db.characters[0]
        character.chats.reverse()
        DBState.db.characters.unshift({ chaId: 'other', chats: [] } as any)
        selectedCharID.set(1)
        await vi.waitFor(() => expect(storage.patchChatContent).toHaveBeenCalled())
        expect(complete).toBe(false)
        release()
        await save

        expect(serverChat.id).toBe('unopened')
        expect(serverChat.message[0].data).toBe('Plugin edit')
        expect(isChatWorkingCopyDirty('character', 'unopened')).toBe(false)
        expect(character.chats[0].id).toBe('unopened')
        expect(character.chats[0].message[0].data).toBe('Plugin edit')
        expect(character.chats[1].message[0].data).toBe('Server body')
    })

    it('leaves the open chat to normal change tracking', async () => {
        await setChatToIndex(0, 0, { message: [{ role: 'user', data: 'Open edit' }] })
        expect(DBState.db.characters[0].chats[0].id).toBe('open')
        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('Open edit')
        expect(storage.patchChatContent).not.toHaveBeenCalled()
    })

    it('reports server read and write failures to the plugin', async () => {
        storage.fetchChatState.mockRejectedValueOnce(new Error('read failed'))
        await expect(getChatFromIndex(0, 1)).rejects.toThrow('read failed')
        const full = (await getChatFromIndex(0, 1))!
        full.message[0].data = 'Failed edit'
        storage.patchChatContent.mockRejectedValueOnce(new Error('write failed'))
        await expect(setChatToIndex(0, 1, full)).rejects.toThrow('write failed')
        expect(DBState.db.characters[0].chats[1].message[0].data).toBe('Failed edit')
        expect(isChatWorkingCopyDirty('character', 'unopened')).toBe(true)
    })
})

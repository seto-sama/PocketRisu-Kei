import { getChatPage } from 'src/ts/storage/chatSelection.svelte'
import { get } from 'svelte/store'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'
import { getCharacterByIndex, normalizeChat, type Chat } from 'src/ts/storage/database.svelte'
import { fetchChatFromServer, saveChatToServer } from 'src/ts/storage/chatStorage'
import { markChatWorkingCopyDirty } from 'src/ts/storage/chatWorkingCopy'

export async function getChatFromIndex(characterIndex: number, chatIndex: number): Promise<Chat | null> {
    const character = getCharacterByIndex(characterIndex)
    const chat = character?.chats?.[chatIndex]
    if (!chat) return null
    if (chat._placeholder) {
        if (!chat.id) return null
        return fetchChatFromServer(character.chaId, chatIndex, chat.id)
    }
    return $state.snapshot(chat)
}

export async function setChatToIndex(characterIndex: number, chatIndex: number, chat: Partial<Chat>): Promise<void> {
    if (!chat || typeof chat !== 'object' || Array.isArray(chat)) {
        throw new Error('setChatToIndex: expected a chat object')
    }
    if (chat._placeholder) {
        throw new Error('setChatToIndex: this chat is not loaded; read it with getChatFromIndex first')
    }
    const character = getCharacterByIndex(characterIndex)
    const slot = character?.chats?.[chatIndex]
    if (!slot) return
    if (chat.id && chat.id !== slot.id) {
        throw new Error('setChatToIndex: chat id does not match the target chat')
    }
    const saved = normalizeChat({ ...chat, id: slot.id })
    markChatWorkingCopyDirty(character.chaId, saved.id)
    character.chats[chatIndex] = saved
    const isOpen = characterIndex === get(selectedCharID) && getChatPage(character) === chatIndex
    if (!isOpen) {
        const characterId = character.chaId
        const chatId = saved.id
        await saveChatToServer(characterId, chatIndex, chatId, saved, {
            getChat: () => DBState.db.characters.find(item => item.chaId === characterId)
                ?.chats.find(item => item.id === chatId),
        })
    }
}

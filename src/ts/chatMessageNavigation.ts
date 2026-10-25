import { getChatPage, setChatPage } from 'src/ts/storage/chatSelection.svelte'
import { get } from 'svelte/store'
import { changeChar } from './characters'
import { changeChatTo } from './globalApi.svelte'
import {
    clearMessageScrollRequest,
    DBState,
    requestMessageScroll,
    selectedCharID,
} from './stores.svelte'

export interface ChatMessageNavigationTarget {
    characterId: string
    chatIndex: number
    messageIndex: number | null
    messageId?: string
    exact?: boolean
}

/** Shared room activation + deferred message-scroll path. */
export function navigateToChatMessage(target: ChatMessageNavigationTarget): boolean {
    const character = DBState.db.characters.find(character => character.chaId === target.characterId)
    const chat = character?.chats?.[target.chatIndex]
    if (!character?.chaId || character.trashTime || !chat?.id) return false

    if (target.messageIndex !== null && target.messageIndex >= 0) {
        requestMessageScroll({
            index: target.messageIndex,
            exact: target.exact,
            characterId: character.chaId,
            chatId: chat.id,
            messageId: target.messageId ?? chat.message?.[target.messageIndex]?.chatId,
        })
    }
    else {
        clearMessageScrollRequest()
    }

    if (DBState.db.characters[get(selectedCharID)]?.chaId !== character.chaId) {
        // Select the destination room before character activation so changeChar
        // hydrates only that room instead of briefly loading the previous room.
        setChatPage(character, target.chatIndex)
        changeChar(character.chaId)
    }
    else if (getChatPage(character) !== target.chatIndex) {
        changeChatTo(target.chatIndex)
    }
    return true
}

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
    characterIndex: number
    chatIndex: number
    messageIndex: number | null
    messageId?: string
    exact?: boolean
}

/** Shared room activation + deferred message-scroll path. */
export function navigateToChatMessage(target: ChatMessageNavigationTarget): boolean {
    const character = DBState.db.characters[target.characterIndex]
    const chat = character?.chats?.[target.chatIndex]
    if (!character?.chaId || !chat?.id) return false

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

    if (get(selectedCharID) !== target.characterIndex) {
        // Select the destination room before character activation so changeChar
        // hydrates only that room instead of briefly loading the old chatPage.
        character.chatPage = target.chatIndex
        changeChar(target.characterIndex)
    }
    else if (character.chatPage !== target.chatIndex) {
        changeChatTo(target.chatIndex)
    }
    return true
}

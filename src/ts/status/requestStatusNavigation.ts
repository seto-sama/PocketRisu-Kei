import { get } from 'svelte/store'
import { changeChar } from '../characters'
import { changeChatTo } from '../globalApi.svelte'
import { DBState, ScrollToMessageStore, selectedCharID, settingsOpen } from '../stores.svelte'
import { findRequestStatusChatTarget } from './requestStatusTarget'

export function navigateToRequestStatusChat(requestChatId: string): boolean {
    const target = findRequestStatusChatTarget(DBState.db, requestChatId)
    if (!target) return false

    if (get(selectedCharID) !== target.characterIndex) {
        changeChar(target.characterIndex)
    }
    if (DBState.db.characters[target.characterIndex]?.chatPage !== target.chatIndex) {
        changeChatTo(target.chatIndex)
    }

    settingsOpen.set(false)
    if (target.messageIndex !== null) {
        ScrollToMessageStore.exact = true
        ScrollToMessageStore.value = target.messageIndex
    }
    else {
        ScrollToMessageStore.exact = false
        ScrollToMessageStore.value = -1
    }
    return true
}

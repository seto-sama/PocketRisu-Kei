import { navigateToChatMessage } from '../chatMessageNavigation'
import { DBState, settingsOpen } from '../stores.svelte'
import { findRequestStatusChatTarget } from './requestStatusTarget'

export function navigateToRequestStatusChat(requestChatId: string): boolean {
    const target = findRequestStatusChatTarget(DBState.db, requestChatId)
    if (!target) return false

    if (!navigateToChatMessage({ ...target, exact: true })) return false
    settingsOpen.set(false)
    return true
}

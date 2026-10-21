import type { Message } from '../storage/database.svelte'
import { removeActiveSwipe } from '../storage/messageSwipes'
import { findLastActiveResponseIndex } from '../storage/messageContent'

export function applyScriptMessageDeletion<T extends Partial<Message>>(
    chat: { message: T[] },
    remaining: T[],
): void {
    const keptMessages = new Set(remaining)
    const removedIndexes = chat.message.flatMap((message, index) =>
        keptMessages.has(message) ? [] : [index],
    )
    if (removedIndexes.length === 1) {
        const index = removedIndexes[0]
        const lastResponseIndex = findLastActiveResponseIndex(chat.message)
        if (lastResponseIndex >= 0 && index >= lastResponseIndex
            && removeActiveSwipe(chat.message[index])) {
            remaining.splice(Math.min(index, remaining.length), 0, chat.message[index])
        }
    }
    chat.message = remaining
}

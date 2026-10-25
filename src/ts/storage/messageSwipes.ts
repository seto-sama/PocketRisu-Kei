import type { Message } from './database.svelte'

export function removeActiveSwipe(message: Partial<Message>): boolean {
    const swipes = message.swipes
    if (!swipes || swipes.length <= 1) return false

    const swipeIndex = message.swipeId ?? 0
    if (!Number.isInteger(swipeIndex) || swipeIndex < 0 || swipeIndex >= swipes.length) return false

    swipes.splice(swipeIndex, 1)
    message.swipeMetadata?.splice(swipeIndex, 1)
    const nextSwipeIndex = Math.min(swipeIndex, swipes.length - 1)
    message.swipeId = nextSwipeIndex
    message.data = swipes[nextSwipeIndex]

    const selectedMetadata = message.swipeMetadata?.[nextSwipeIndex]
    if (selectedMetadata) {
        message.chatId = selectedMetadata.chatId ?? message.chatId
        message.time = selectedMetadata.time ?? message.time
        message.generationInfo = selectedMetadata.generationInfo ?? message.generationInfo
        message.promptInfo = selectedMetadata.promptInfo ?? message.promptInfo
    }

    if (swipes.length === 1) {
        delete message.swipes
        delete message.swipeId
        delete message.swipeMetadata
    }

    return true
}

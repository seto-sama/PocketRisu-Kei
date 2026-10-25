import type { Message } from './database.svelte'

export function findLastActiveResponseIndex(messages: readonly Partial<Message>[]): number {
    return messages.findLastIndex(message =>
        message.role === 'char' && !message.isComment && !message.disabled,
    )
}

export function setMessageContent(
    message: Pick<Partial<Message>, 'data' | 'swipes' | 'swipeId'>,
    content: string,
): void {
    message.data = content
    const { swipes, swipeId } = message
    if (Array.isArray(swipes) && typeof swipeId === 'number' && Number.isInteger(swipeId)
        && swipeId >= 0 && swipeId < swipes.length) {
        swipes[swipeId] = content
    }
}

import type { Message } from 'src/ts/storage/database.svelte'
import { inlayTokenRegex } from 'src/ts/util/inlayTokens'

export type ChatInlayViewerEntry = {
    id: string
    messageIndex: number
    occurrence: number
}

function collectSourceEntries(source: string, messageIndex: number): ChatInlayViewerEntry[] {
    const occurrences = new Map<string, number>()
    const entries: ChatInlayViewerEntry[] = []
    for (const match of source.matchAll(inlayTokenRegex)) {
        const id = match[2]
        if (!id) continue
        const occurrence = occurrences.get(id) ?? 0
        occurrences.set(id, occurrence + 1)
        entries.push({ id, messageIndex, occurrence })
    }
    return entries
}

export function collectChatInlayViewerEntries(
    firstMessage: string,
    messages: readonly Message[],
): ChatInlayViewerEntry[] {
    return [
        ...collectSourceEntries(firstMessage, -1),
        ...messages.flatMap((message, messageIndex) => collectSourceEntries(message.data, messageIndex)),
    ]
}

export function removeChatInlayOccurrence(
    source: string,
    target: Pick<ChatInlayViewerEntry, 'id' | 'occurrence'>,
): string {
    let occurrence = 0
    return source.replace(inlayTokenRegex, (token, _kind: string, id: string) => {
        if (id !== target.id) return token
        if (occurrence++ !== target.occurrence) return token
        return ''
    })
}

export function isEmptyChatInlayMessage(source: string): boolean {
    return source.trim().length === 0
}

export function removeCurrentEmptyInlaySwipe(message: Message): boolean {
    if (!message.swipes || message.swipes.length <= 1) return false
    const swipeIndex = message.swipeId ?? 0
    message.swipes.splice(swipeIndex, 1)
    message.swipeMetadata?.splice(swipeIndex, 1)
    message.swipeId = Math.min(swipeIndex, message.swipes.length - 1)
    message.data = message.swipes[message.swipeId]

    if (message.swipes.length === 1) {
        const remainingMetadata = message.swipeMetadata?.[0]
        if (remainingMetadata) {
            message.chatId = remainingMetadata.chatId ?? message.chatId
            message.time = remainingMetadata.time ?? message.time
            message.generationInfo = remainingMetadata.generationInfo ?? message.generationInfo
            message.promptInfo = remainingMetadata.promptInfo ?? message.promptInfo
        }
        delete message.swipes
        delete message.swipeId
        delete message.swipeMetadata
    }
    return true
}

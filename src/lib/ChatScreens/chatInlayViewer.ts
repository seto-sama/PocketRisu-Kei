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

import { createEntityId } from 'src/ts/id';
import type { Chat } from './storage/database.svelte'

/**
 * Gives a copied or branched chat its own message ids and rewrites references
 * stored inside that chat. The chat room id itself is managed by the caller.
 *
 * `sourceMessageIds` must come from the complete source before a branch is
 * truncated. Memory that points beyond the branch is removed, while an orphan
 * that already existed in the source is preserved for legacy compatibility.
 */
export function reissueMessageIds(
    chat: Chat,
    sourceMessageIds: Iterable<string | undefined>,
): Chat {
    const idMap = new Map<string, string>()
    for (const message of chat.message) {
        const next = createEntityId()
        if (message.chatId) idMap.set(message.chatId, next)
        message.chatId = next
    }

    const sourceIds = new Set<string>()
    for (const id of sourceMessageIds) {
        if (id) sourceIds.add(id)
    }

    if (chat.hypaV3Data?.summaries) {
        const before = chat.hypaV3Data.summaries.length
        chat.hypaV3Data.summaries = chat.hypaV3Data.summaries.flatMap(summary => {
            const chatMemos: string[] = []
            for (const memo of summary.chatMemos ?? []) {
                // null represents the character greeting, which is not stored
                // in Chat.message and therefore has no id to reissue.
                if (memo == null) {
                    chatMemos.push(memo)
                    continue
                }
                const mapped = idMap.get(memo)
                if (mapped) chatMemos.push(mapped)
                else if (sourceIds.has(memo)) return []
                else chatMemos.push(memo)
            }
            return [{ ...summary, chatMemos }]
        })
        if (chat.hypaV3Data.summaries.length !== before) {
            // These fields contain summary indexes and become stale after a
            // branch drops summaries that refer to messages past the cut.
            delete chat.hypaV3Data.metrics
            delete chat.hypaV3Data.lastSelectedSummaries
        }
    }

    if (chat.bookmarks) {
        chat.bookmarks = chat.bookmarks.flatMap(id => {
            const mapped = idMap.get(id)
            return mapped ? [mapped] : []
        })
    }
    if (chat.bookmarkNames) {
        chat.bookmarkNames = remapMessageKeyedRecord(chat.bookmarkNames, idMap)
    }
    if (chat.bookmarkTagIds) {
        chat.bookmarkTagIds = remapMessageKeyedRecord(chat.bookmarkTagIds, idMap)
    }

    return chat
}

function remapMessageKeyedRecord<T>(
    record: Record<string, T>,
    idMap: ReadonlyMap<string, string>,
): Record<string, T> {
    const remapped: Record<string, T> = {}
    for (const [id, value] of Object.entries(record)) {
        const mapped = idMap.get(id)
        if (mapped) remapped[mapped] = value
    }
    return remapped
}

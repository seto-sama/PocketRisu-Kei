import type { Chat, Database } from '../storage/database.svelte'
import type {
    BookmarkCatalog,
    BookmarkCompatibilityData,
    GlobalBookmarkEntry,
} from './bookmarkTypes'

export function collectGlobalBookmarks(
    db: Database,
    catalog: BookmarkCatalog,
): GlobalBookmarkEntry[] {
    const characters = new Map(
        (db.characters ?? [])
            .filter(character => character?.chaId)
            .map((character, characterIndex) => [
                character.chaId,
                { character, characterIndex },
            ] as const),
    )
    const entries: GlobalBookmarkEntry[] = []
    for (const bookmark of catalog.entries) {
        const locatedCharacter = characters.get(bookmark.characterId)
        if (!locatedCharacter) continue
        const chatIndex = locatedCharacter.character.chats.findIndex(chat => chat?.id === bookmark.chatId)
        if (chatIndex < 0) continue
        const chat = locatedCharacter.character.chats[chatIndex]
        entries.push({
            ...bookmark,
            tagIds: [...bookmark.tagIds],
            characterIndex: locatedCharacter.characterIndex,
            characterName: locatedCharacter.character.name ?? '',
            chatIndex,
            chatName: chat.name ?? '',
        })
    }
    return entries
}

export function applyBookmarkCompatibility(
    chat: Chat,
    data?: BookmarkCompatibilityData,
): Chat {
    const compatible = structuredClone(chat)
    compatible.bookmarks = [...(data?.bookmarks ?? [])]
    if (data?.bookmarkNames && Object.keys(data.bookmarkNames).length > 0) {
        compatible.bookmarkNames = { ...data.bookmarkNames }
    }
    else {
        delete compatible.bookmarkNames
    }
    if (data?.bookmarkTagIds && Object.keys(data.bookmarkTagIds).length > 0) {
        compatible.bookmarkTagIds = Object.fromEntries(
            Object.entries(data.bookmarkTagIds).map(([id, tagIds]) => [id, [...tagIds]]),
        )
    }
    else {
        delete compatible.bookmarkTagIds
    }
    return compatible
}

export function remapBookmarkTags(
    chat: Chat,
    idMap: Record<string, string>,
): void {
    if (!chat.bookmarkTagIds) return
    for (const messageId of Object.keys(chat.bookmarkTagIds)) {
        chat.bookmarkTagIds[messageId] = chat.bookmarkTagIds[messageId]
            .map(id => idMap[id])
            .filter(Boolean)
    }
}

export function stripBookmarkCompatibility(chat: Chat): void {
    delete chat.bookmarks
    delete chat.bookmarkNames
    delete chat.bookmarkTagIds
}

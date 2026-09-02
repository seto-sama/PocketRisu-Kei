import type { PresetTag } from '../preset/tags'

export interface BookmarkCatalogEntry {
    characterId: string
    chatId: string
    messageId: string
    name: string
    customName?: string | null
    preview: string
    tagIds: string[]
    sortOrder: number
}

export interface BookmarkCatalog {
    revision: number
    tags: PresetTag[]
    entries: BookmarkCatalogEntry[]
}

export interface BookmarkTarget {
    characterId: string
    chatId: string
    messageId: string
}

export interface BookmarkCompatibilityData {
    bookmarks: string[]
    bookmarkNames?: Record<string, string>
    bookmarkTagIds?: Record<string, string[]>
}

export interface BookmarkCompatibilityResult {
    entries: Array<{
        characterId: string
        chatId: string
        data: BookmarkCompatibilityData
    }>
    tags: PresetTag[]
}

export interface GlobalBookmarkEntry extends BookmarkCatalogEntry {
    characterIndex: number
    characterName: string
    chatIndex: number
    chatName: string
}

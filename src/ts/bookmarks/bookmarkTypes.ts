import type { PromptPresetFolder } from '../storage/database.svelte'

export interface BookmarkCatalogEntry {
    characterId: string
    chatId: string
    messageId: string
    name: string
    customName?: string | null
    preview: string
    folderId?: string | null
    sortOrder: number
}

export interface BookmarkCatalog {
    revision: number
    folders: PromptPresetFolder[]
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
    bookmarkFolderIds?: Record<string, string>
}

export interface BookmarkCompatibilityResult {
    entries: Array<{
        characterId: string
        chatId: string
        data: BookmarkCompatibilityData
    }>
    folders: PromptPresetFolder[]
}

export interface GlobalBookmarkEntry extends BookmarkCatalogEntry {
    characterIndex: number
    characterName: string
    chatIndex: number
    chatName: string
}

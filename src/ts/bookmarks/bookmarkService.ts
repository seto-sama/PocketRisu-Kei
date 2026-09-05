import { derived, get, writable } from 'svelte/store'
import { navigateToChatMessage } from '../chatMessageNavigation'
import { forageStorage } from '../storage/autoStorage'
import { ensureChatHydrated } from '../storage/chatStorage'
import type { PresetTag } from '../preset/tags'
import type { Chat, Database } from '../storage/database.svelte'
import { DBState } from '../stores.svelte'
import { applyBookmarkCompatibility, stripBookmarkCompatibility } from './bookmarkData'
import type {
    BookmarkCatalog,
    BookmarkCompatibilityResult,
    BookmarkTarget,
    GlobalBookmarkEntry,
} from './bookmarkTypes'

const emptyCatalog: BookmarkCatalog = { revision: 0, tags: [], entries: [] }

export const bookmarkCatalog = writable<BookmarkCatalog>(emptyCatalog)
export const bookmarkCatalogLoaded = writable(false)
export const bookmarkCatalogLoading = writable(false)
export const bookmarkKeys = derived(bookmarkCatalog, catalog => new Set(
    catalog.entries.map(entry => bookmarkKey(entry)),
))

let catalogRequest: Promise<BookmarkCatalog> | null = null
let refreshQueued = false

export function bookmarkKey(target: BookmarkTarget): string {
    return `${target.characterId}\u0000${target.chatId}\u0000${target.messageId}`
}

function installCatalog(catalog: BookmarkCatalog): BookmarkCatalog {
    bookmarkCatalog.update(current => catalog.revision >= current.revision ? catalog : current)
    bookmarkCatalogLoaded.set(true)
    return catalog
}

export async function refreshBookmarkCatalog(
    options?: { queueIfBusy?: boolean },
): Promise<BookmarkCatalog> {
    if (catalogRequest) {
        if (options?.queueIfBusy) refreshQueued = true
        return catalogRequest
    }
    bookmarkCatalogLoading.set(true)
    catalogRequest = forageStorage.realStorage.fetchBookmarkCatalog()
        .then(installCatalog)
        .finally(() => {
            bookmarkCatalogLoading.set(false)
            catalogRequest = null
            if (refreshQueued) {
                refreshQueued = false
                void refreshBookmarkCatalog().catch(error => {
                    console.error('[bookmarks] Queued catalog refresh failed', error)
                })
            }
        })
    return catalogRequest
}

export function ensureBookmarkCatalog(): Promise<BookmarkCatalog> {
    return get(bookmarkCatalogLoaded)
        ? Promise.resolve(get(bookmarkCatalog))
        : refreshBookmarkCatalog()
}

export async function createBookmark(
    target: BookmarkTarget,
    name: string,
): Promise<void> {
    installCatalog(await forageStorage.realStorage.putBookmark({ ...target, name }))
}

export async function deleteBookmark(target: BookmarkTarget): Promise<void> {
    installCatalog(await forageStorage.realStorage.deleteBookmark(target))
}

export async function renameBookmark(target: BookmarkTarget, name: string): Promise<void> {
    installCatalog(await forageStorage.realStorage.patchBookmark(target, { name }))
}

export async function assignBookmarkTags(
    target: BookmarkTarget,
    tagIds: string[],
): Promise<void> {
    installCatalog(await forageStorage.realStorage.patchBookmark(target, { tagIds }))
}

export async function replaceBookmarkTags(tags: PresetTag[]): Promise<void> {
    installCatalog(await forageStorage.realStorage.replaceBookmarkTags(tags))
}

export async function mergeBookmarkTagsForImport(
    tags: unknown,
): Promise<Record<string, string>> {
    const result = await forageStorage.realStorage.mergeBookmarkTags(tags)
    installCatalog(result.catalog)
    return result.idMap
}

export function fetchBookmarkCompatibility(
    targets: Array<{ characterId: string, chatId: string }>,
): Promise<BookmarkCompatibilityResult> {
    return forageStorage.realStorage.fetchBookmarkCompatibility(targets)
}

export async function prepareBookmarkCompatibleChats(
    characterId: string,
    chats: Chat[],
): Promise<{ chats: Chat[], tags: PresetTag[] }> {
    const compatibility = await fetchBookmarkCompatibility(
        chats.map(chat => ({ characterId, chatId: chat.id })),
    )
    const compatibilityByChat = new Map(
        compatibility.entries.map(entry => [entry.chatId, entry.data]),
    )
    return {
        chats: chats.map(chat =>
            applyBookmarkCompatibility(chat, compatibilityByChat.get(chat.id))),
        tags: compatibility.tags,
    }
}

export async function finalizeImportedBookmarks(chats: Chat[]): Promise<void> {
    chats.forEach(stripBookmarkCompatibility)
    await refreshBookmarkCatalog()
}

type BookmarkLocation = Pick<GlobalBookmarkEntry, 'characterId' | 'chatId' | 'messageId'>

function locateBookmark(db: Database, target: BookmarkLocation) {
    const characterIndex = db.characters.findIndex(character => character?.chaId === target.characterId)
    if (characterIndex < 0) return null
    const character = db.characters[characterIndex]
    const chatIndex = character.chats.findIndex(chat => chat?.id === target.chatId)
    if (chatIndex < 0) return null
    return { character, characterIndex, chatIndex }
}

export async function navigateToBookmark(target: BookmarkLocation): Promise<boolean> {
    const location = locateBookmark(DBState.db, target)
    if (!location) return false
    const chat = await ensureChatHydrated(
        location.character.chats,
        location.chatIndex,
        location.character.chaId,
    )
    if (!chat) return false
    const messageIndex = chat.message.findIndex(message => message?.chatId === target.messageId)
    if (messageIndex < 0) return false

    return navigateToChatMessage({
        characterIndex: location.characterIndex,
        chatIndex: location.chatIndex,
        messageIndex,
        messageId: target.messageId,
        exact: false,
    })
}

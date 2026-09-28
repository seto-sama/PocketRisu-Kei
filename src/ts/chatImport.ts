import { createEntityId } from './id'
import { normalizeChat, type Chat, type ChatFolder, type character } from './storage/database.svelte'
import { requestImmediateSave } from './globalApi.svelte'
import { remapBookmarkTags } from './bookmarks/bookmarkData'
import { finalizeImportedBookmarks, mergeBookmarkTagsForImport } from './bookmarks/bookmarkService'

/** Import released v1 and v2 JSON exports through one chat save path. */
export async function importRisuChats(data: unknown, target: character | undefined): Promise<boolean> {
    if (!target || !data || typeof data !== 'object' || Array.isArray(data)) return false

    const json = data as {
        type?: string
        ver?: number
        data?: unknown
        folders?: ChatFolder[]
        bookmarkTags?: unknown[]
    }
    if ((json.type !== 'risuAllChats' && json.type !== 'risuChat') || (json.ver !== 1 && json.ver !== 2)) return false

    const chats = Array.isArray(json.data) ? json.data : [json.data]
    if (!chats.length || chats.some(chat => !chat || typeof chat !== 'object' || Array.isArray(chat))) return false

    // v1 has chat bodies only; absent metadata follows the same path as v2's empty metadata.
    const metadata = json.ver === 2 ? json : undefined
    const folderIdMap = new Map<string, string>()
    const folders = metadata?.folders ?? []
    for (const folder of folders) {
        const id = target.chatFolders?.some(existing => existing.id === folder.id) ? createEntityId() : folder.id
        folderIdMap.set(folder.id, id)
        folder.id = id
    }
    if (folders.length) {
        target.chatFolders ??= []
        target.chatFolders.push(...folders)
    }

    const tagIdMap = metadata?.bookmarkTags?.length
        ? await mergeBookmarkTagsForImport(metadata.bookmarkTags)
        : {}
    const importedChats = (chats as Chat[]).map(chat => {
        chat.fmIndex ??= -1
        if (metadata) {
            if (chat.folderId) chat.folderId = folderIdMap.get(chat.folderId) ?? chat.folderId
            remapBookmarkTags(chat, tagIdMap)
        }
        chat.id = createEntityId()
        return normalizeChat(chat)
    })

    target.chats.unshift(...importedChats)
    await requestImmediateSave({
        characterIds: [target.chaId],
        chatTargets: importedChats.map(chat => ({ characterId: target.chaId, chatId: chat.id })),
    })
    if (metadata) await finalizeImportedBookmarks(importedChats)
    return true
}

import { writable } from 'svelte/store'
import { saveAsset } from 'src/ts/globalApi.svelte'
import { DBState } from 'src/ts/stores.svelte'
import type { ChatFolder, folder } from 'src/ts/storage/database.svelte'
import { selectSingleFile } from 'src/ts/util'

export const folderSettingsTarget = writable<string | null>(null)
export interface ChatFolderSettingsTarget {
    characterId: string
    folderId: string
}

export const chatFolderSettingsTarget = writable<ChatFolderSettingsTarget | null>(null)

function clearFolderSettingsTargets() {
    folderSettingsTarget.set(null)
    chatFolderSettingsTarget.set(null)
}

export function findSidebarFolder(id: string) {
    return DBState.db.characterOrder.find((entry): entry is folder => typeof entry !== 'string' && entry.id === id)
}

export function updateSidebarFolder(id: string, patch: Partial<Omit<folder, 'id' | 'data'>>) {
    const current = findSidebarFolder(id)
    if (current) Object.assign(current, patch)
}

export function openSidebarFolderMenu(id: string) {
    if (findSidebarFolder(id)) {
        clearFolderSettingsTargets()
        folderSettingsTarget.set(id)
    }
}

export function findChatFolder(characterId: string, folderId: string) {
    return DBState.db.characters.find(character => character?.chaId === characterId)?.chatFolders?.find(folder => folder.id === folderId)
}

export function updateChatFolder(
    characterId: string,
    folderId: string,
    patch: Partial<Omit<ChatFolder, 'id' | 'folded'>>,
) {
    const current = findChatFolder(characterId, folderId)
    if (current) Object.assign(current, patch)
}

export function openChatFolderMenu(characterId: string, folderId: string) {
    if (findChatFolder(characterId, folderId)) {
        clearFolderSettingsTargets()
        chatFolderSettingsTarget.set({ characterId, folderId })
    }
}

export function deleteChatFolder(characterId: string, folderId: string) {
    const character = DBState.db.characters.find(item => item?.chaId === characterId)
    const folders = character?.chatFolders
    if (!character || !folders?.some(folder => folder.id === folderId)) return false

    for (const chat of character.chats) {
        if (chat.folderId === folderId) chat.folderId = undefined
    }
    character.chats = [...character.chats]
    character.chatFolders = folders.filter(folder => folder.id !== folderId)
    return true
}

export async function pickSidebarFolderImage(id: string) {
    const file = await selectSingleFile(['png', 'jpg', 'webp'])
    if (!file || !findSidebarFolder(id)) return
    const imgFile = await saveAsset(file.data)
    // Resolve again after the upload: a projection or folder deletion may have occurred.
    updateSidebarFolder(id, { imgFile, img: '' })
}

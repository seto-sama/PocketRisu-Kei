import { writable } from 'svelte/store'
import { saveAsset } from 'src/ts/globalApi.svelte'
import { DBState } from 'src/ts/stores.svelte'
import type { folder } from 'src/ts/storage/database.svelte'
import { selectSingleFile } from 'src/ts/util'

export const folderSettingsTarget = writable<string | null>(null)

export function findSidebarFolder(id: string) {
    return DBState.db.characterOrder.find((entry): entry is folder => typeof entry !== 'string' && entry.id === id)
}

export function updateSidebarFolder(id: string, patch: Partial<Omit<folder, 'id' | 'data'>>) {
    const current = findSidebarFolder(id)
    if (current) Object.assign(current, patch)
}

export function openSidebarFolderMenu(id: string) {
    if (findSidebarFolder(id)) folderSettingsTarget.set(id)
}

export async function pickSidebarFolderImage(id: string) {
    const file = await selectSingleFile(['png', 'jpg', 'webp'])
    if (!file || !findSidebarFolder(id)) return
    const imgFile = await saveAsset(file.data)
    // Resolve again after the upload: a projection or folder deletion may have occurred.
    updateSidebarFolder(id, { imgFile, img: '' })
}

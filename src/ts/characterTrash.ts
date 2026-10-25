import type { character, folder } from './storage/database.svelte'

type CharacterOrder = (string | folder)[]

/**
 * Marks a character as trashed. checkCharOrder then takes it out of its folder
 * and drops the folder once empty, so the folder settings are kept on the
 * character for restoreFromTrash.
 */
export function moveToTrash(order: CharacterOrder, char: character) {
    char.trashTime = Date.now()
    const source = order.find((entry): entry is folder => typeof entry !== 'string' && entry.data.includes(char.chaId))
    if (source) {
        const { data: _data, ...folderSettings } = source
        char.trashFolder = folderSettings
    }
}

/** Clears the trash marker and puts the character back into its folder, recreating a folder that was dropped. */
export function restoreFromTrash(order: CharacterOrder, char: character) {
    const saved = char.trashFolder
    char.trashTime = undefined
    char.trashFolder = undefined
    if (!saved) return
    const existing = order.find((entry): entry is folder => typeof entry !== 'string' && entry.id === saved.id)
    if (!existing) {
        order.push({ ...saved, data: [char.chaId] })
    } else if (!existing.data.includes(char.chaId)) {
        existing.data.push(char.chaId)
    }
}

import type { character } from './storage/database.svelte'

const ARCHIVED_ICON_NAME = 'iconx'
const DEFAULT_IMAGE_EXTENSION = 'png'

export function archiveCurrentCharacterIcon(currentCharacter: character): void {
    if (!currentCharacter.image) return

    currentCharacter.ccAssets ??= []
    currentCharacter.ccAssets.push({
        type: 'icon',
        name: ARCHIVED_ICON_NAME,
        uri: currentCharacter.image,
        ext: currentCharacter.image.split('.').pop() || DEFAULT_IMAGE_EXTENSION,
    })
    currentCharacter.image = ''
}

/** Converts a legacy emotion image row into an additional-asset row. */
export function emotionImageToAsset([name, path]: [string, string]): [string, string, string] {
    const fileName = path.split('/').pop() ?? ''
    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : DEFAULT_IMAGE_EXTENSION
    return [name, path, ext]
}

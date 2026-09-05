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

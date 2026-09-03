import { saveAsset } from '../globalApi.svelte'
import { archiveCurrentCharacterIcon } from '../characterAssets'
import { getInlayAssetBlob } from '../process/files/inlays'
import type { character } from '../storage/database.svelte'

export type GeneratedImageAssetTarget = 'icon' | 'emotion' | 'additional'

const INLAY_REFERENCE = /\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/

export class GeneratedInlayAssetError extends Error {}

function uniqueAssetName(name: string, existingNames: Iterable<string>): string {
    const names = new Set(existingNames)
    if (!names.has(name)) return name

    let suffix = 2
    while (names.has(`${name} ${suffix}`)) suffix += 1
    return `${name} ${suffix}`
}

function assetBaseName(name: string, extension: string, inlayId: string): string {
    const trimmed = name.trim()
    const extensionSuffix = extension ? `.${extension.toLowerCase()}` : ''
    const withoutExtension = extensionSuffix && trimmed.toLowerCase().endsWith(extensionSuffix)
        ? trimmed.slice(0, -extensionSuffix.length)
        : trimmed
    return withoutExtension || inlayId
}

export async function addGeneratedInlayToCharacter(
    message: string,
    currentCharacter: character,
    target: GeneratedImageAssetTarget,
): Promise<{ path: string, name: string }> {
    const inlayId = INLAY_REFERENCE.exec(message)?.[1]
    if (!inlayId) throw new GeneratedInlayAssetError()

    const inlay = await getInlayAssetBlob(inlayId)
    if (!inlay || inlay.type !== 'image') {
        throw new GeneratedInlayAssetError()
    }

    const bytes = new Uint8Array(await inlay.data.arrayBuffer())
    const extension = inlay.ext || 'png'
    const path = await saveAsset(bytes, '', extension)
    const baseName = assetBaseName(inlay.name, extension, inlayId)

    if (target === 'icon') {
        archiveCurrentCharacterIcon(currentCharacter)
        currentCharacter.image = path
        return { path, name: baseName }
    }

    if (target === 'emotion') {
        currentCharacter.emotionImages ??= []
        const name = uniqueAssetName(baseName, currentCharacter.emotionImages.map(([itemName]) => itemName))
        currentCharacter.emotionImages.push([name, path])
        return { path, name }
    }

    currentCharacter.additionalAssets ??= []
    const name = uniqueAssetName(baseName, currentCharacter.additionalAssets.map(([itemName]) => itemName))
    currentCharacter.additionalAssets.push([name, path, extension])
    return { path, name }
}

import { saveAsset } from '../globalApi.svelte'
import { archiveCurrentCharacterIcon } from '../characterAssets'
import { getInlayAssetBlob, getInlayMeta } from '../process/files/inlays'
import type { character } from '../storage/database.svelte'
import { getFirstInlayId } from '../util/inlayTokens'

export type GeneratedImageAssetTarget = 'icon' | 'additional'

export class GeneratedInlayAssetError extends Error {}

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
    const inlayId = getFirstInlayId(message)
    if (!inlayId) throw new GeneratedInlayAssetError()

    const inlay = await getInlayAssetBlob(inlayId)
    if (!inlay || inlay.type !== 'image') {
        throw new GeneratedInlayAssetError()
    }

    const bytes = new Uint8Array(await inlay.data.arrayBuffer())
    const extension = inlay.ext || 'png'
    const path = await saveAsset(bytes, '', extension)
    const preset = (await getInlayMeta(inlayId))?.imageGeneration?.preset
    const name = preset?.tagBundleNames.length && preset.sceneName
        ? [...preset.tagBundleNames, preset.sceneName].join('_')
        : assetBaseName(inlay.name, extension, inlayId)

    if (target === 'icon') {
        archiveCurrentCharacterIcon(currentCharacter)
        currentCharacter.image = path
    }
    else {
        currentCharacter.additionalAssets ??= []
        currentCharacter.additionalAssets.push([name, path, extension])
    }
    return { path, name }
}

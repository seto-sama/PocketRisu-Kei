import { saveAsset } from '../globalApi.svelte'
import { sha256Hex } from '../hash'
import { archiveCurrentCharacterIcon } from '../characterAssets'
import { getInlayAssetBlob, getInlayMeta } from '../process/files/inlays'
import type { character } from '../storage/database.svelte'
import { getFirstInlayId, getInlayIds } from '../util/inlayTokens'

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

async function saveInlayImageAsset(
    inlayId: string,
    isExistingAsset: (path: string) => boolean = () => false,
): Promise<{ path: string, name: string, extension: string } | null> {
    const inlay = await getInlayAssetBlob(inlayId)
    if (!inlay || inlay.type !== 'image') return null

    const bytes = new Uint8Array(await inlay.data.arrayBuffer())
    const extension = inlay.ext || 'png'
    // Hashing up front mirrors saveAsset's path so known images skip the upload.
    // crypto.subtle is missing on insecure origins; saveAsset then picks its own id.
    const hash = await sha256Hex(bytes).catch(() => '')
    if (hash && isExistingAsset(`assets/${hash}.${extension}`)) return null
    const path = await saveAsset(bytes, hash, extension)
    const preset = (await getInlayMeta(inlayId))?.imageGeneration?.preset
    const name = preset?.tagBundleNames.length && preset.sceneName
        ? [...preset.tagBundleNames, preset.sceneName].join('_')
        : assetBaseName(inlay.name, extension, inlayId)
    return { path, name, extension }
}

export async function addGeneratedInlayToCharacter(
    message: string,
    currentCharacter: character,
    target: GeneratedImageAssetTarget,
): Promise<{ path: string, name: string }> {
    const inlayId = getFirstInlayId(message)
    if (!inlayId) throw new GeneratedInlayAssetError()

    const asset = await saveInlayImageAsset(inlayId)
    if (!asset) throw new GeneratedInlayAssetError()
    const { path, name, extension } = asset

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

/** Adds every inlay image referenced by `messages` to the additional assets.
 * Asset paths are content hashes, so images already in the list are skipped
 * and repeating the action does not pile up duplicates. */
export async function addChatInlaysToCharacterAssets(
    messages: readonly string[],
    currentCharacter: character,
): Promise<number> {
    // Read the live list each time: another add can finish while this one awaits.
    const hasAsset = (path: string) => currentCharacter.additionalAssets?.some(asset => asset[1] === path) ?? false
    let added = 0
    for (const inlayId of getInlayIds(messages)) {
        const asset = await saveInlayImageAsset(inlayId, hasAsset)
        if (!asset || hasAsset(asset.path)) continue
        currentCharacter.additionalAssets ??= []
        currentCharacter.additionalAssets.push([asset.name, asset.path, asset.extension])
        added++
    }
    return added
}

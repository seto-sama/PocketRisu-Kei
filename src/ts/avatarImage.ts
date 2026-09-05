import { readImage } from './globalApi.svelte'

const DEFAULT_AVATAR_PATH = '/none.webp'
let defaultAvatarImagePromise: Promise<Uint8Array> | null = null

export async function readDefaultAvatarImage(): Promise<Uint8Array> {
    defaultAvatarImagePromise ??= fetch(DEFAULT_AVATAR_PATH)
        .then(async (response) => {
            if (!response.ok) throw new Error(`Failed to load ${DEFAULT_AVATAR_PATH}`)
            return new Uint8Array(await response.arrayBuffer())
        })
        .catch((error) => {
            defaultAvatarImagePromise = null
            throw error
        })

    return (await defaultAvatarImagePromise).slice()
}

export async function readAvatarImageOrDefault(icon: string): Promise<Uint8Array> {
    if (icon) return readImage(icon)
    return readDefaultAvatarImage()
}

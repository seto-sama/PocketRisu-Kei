import { readImage } from './globalApi.svelte'

const DEFAULT_AVATAR_PATH = '/none.webp'
let defaultAvatarImagePromise: Promise<Uint8Array> | null = null

export async function readDefaultAvatarImage(): Promise<Uint8Array> {
    defaultAvatarImagePromise ??= fetch(DEFAULT_AVATAR_PATH)
        .then(async (response) => {
            if (!response.ok) throw new Error(`Failed to load ${DEFAULT_AVATAR_PATH}`)
            const image = new Uint8Array(await response.arrayBuffer())
            if (image.byteLength === 0) throw new Error(`Empty image from ${DEFAULT_AVATAR_PATH}`)
            return image
        })
        .catch((error) => {
            defaultAvatarImagePromise = null
            throw error
        })

    return (await defaultAvatarImagePromise).slice()
}

export async function readAvatarImageOrDefault(icon?: string): Promise<Uint8Array> {
    if (icon) {
        try {
            const image = await readImage(icon)
            if (image.byteLength > 0) return image
        } catch {}
    }
    return readDefaultAvatarImage()
}

import { getChatPage } from 'src/ts/storage/chatSelection.svelte'
import { getCurrentCharacter } from "../../storage/database.svelte";
import { NodeStorage } from "../../storage/nodeStorage";

const INLAY_META_PREFIX = 'inlay_meta/'

export interface ImagePresetMetadata {
    tagBundleNames: string[]
    sceneName: string
}

export type InlayAssetMeta = {
    createdAt: number
    updatedAt: number
    charId?: string
    chatId?: string
    imageGeneration?: {
        prompt: string
        negativePrompt: string
        seed?: number
        preset?: ImagePresetMetadata
    }
}

class NodeInlayMetaStorage {
    private nodeStorage = new NodeStorage()

    private serverKey(id: string): string {
        return `${INLAY_META_PREFIX}${id}`
    }

    async setItem(id: string, meta: InlayAssetMeta): Promise<void> {
        const bytes = new TextEncoder().encode(JSON.stringify(meta))
        await this.nodeStorage.setItem(this.serverKey(id), bytes)
    }

    async getItem(id: string): Promise<InlayAssetMeta | null> {
        try {
            const buf = await this.nodeStorage.getItem(this.serverKey(id))
            if (!buf || buf.length === 0) return null
            return decodeInlayMeta(buf)
        } catch {
            return null
        }
    }

    async getItems(ids: string[]): Promise<Record<string, InlayAssetMeta>> {
        const result: Record<string, InlayAssetMeta> = {}
        if (ids.length === 0) return result
        try {
            const rows = await this.nodeStorage.getItems(ids.map((id) => this.serverKey(id)))
            for (const row of rows) {
                try {
                    const id = row.key.replace(INLAY_META_PREFIX, '')
                    result[id] = decodeInlayMeta(row.value)
                } catch {
                    // skip corrupt meta entries
                }
            }
        } catch {
            // best-effort batch read
        }
        return result
    }

    async removeItem(id: string): Promise<void> {
        try {
            await this.nodeStorage.removeItem(this.serverKey(id))
        } catch {
            // ignore
        }
    }

}

function decodeInlayMeta(bytes: Uint8Array): InlayAssetMeta {
    const raw = JSON.parse(new TextDecoder().decode(bytes))
    const createdAt = typeof raw?.createdAt === 'number' ? raw.createdAt : 0
    const updatedAt = typeof raw?.updatedAt === 'number' ? raw.updatedAt : createdAt
    const charId = typeof raw?.charId === 'string' ? raw.charId : undefined
    const chatId = typeof raw?.chatId === 'string' ? raw.chatId : undefined
    const imageGeneration = parseImageGenerationMeta(raw?.imageGeneration)
    return { createdAt, updatedAt, charId, chatId, imageGeneration }
}

function parseImageGenerationMeta(value: unknown): InlayAssetMeta['imageGeneration'] {
    if(!value || typeof value !== 'object') return undefined
    const data = value as Record<string, unknown>
    if(typeof data.prompt !== 'string' || typeof data.negativePrompt !== 'string') return undefined
    const seed = typeof data.seed === 'number' && Number.isFinite(data.seed)
        ? data.seed
        : undefined
    const source = data.preset as Partial<ImagePresetMetadata> | undefined
    const preset = source && typeof source.sceneName === 'string'
        && Array.isArray(source.tagBundleNames) && source.tagBundleNames.every(name => typeof name === 'string')
        ? { tagBundleNames: source.tagBundleNames, sceneName: source.sceneName }
        : undefined
    return { prompt: data.prompt, negativePrompt: data.negativePrompt, seed, preset }
}

let _storage: NodeInlayMetaStorage | null = null
function getStorage(): NodeInlayMetaStorage {
    if (!_storage) _storage = new NodeInlayMetaStorage()
    return _storage
}

export async function setInlayMeta(id: string, meta: InlayAssetMeta): Promise<void> {
    await getStorage().setItem(id, meta)
}

export async function removeInlayMeta(id: string): Promise<void> {
    await getStorage().removeItem(id)
}

export async function getInlayMeta(id: string): Promise<InlayAssetMeta | null> {
    return await getStorage().getItem(id)
}

export async function getInlayMetasBatch(ids: string[]): Promise<Record<string, InlayAssetMeta>> {
    return await getStorage().getItems(ids)
}

export function buildInlayMeta(existingMeta?: InlayAssetMeta | null): InlayAssetMeta {
    const now = Date.now()
    const currentChar = getCurrentCharacter()
    const currentCharId = typeof currentChar?.chaId === 'string' ? currentChar.chaId : undefined
    const currentChat = currentChar?.chats?.[getChatPage(currentChar)]
    const currentChatId = typeof currentChat?.id === 'string' ? currentChat.id : undefined

    return {
        createdAt: (existingMeta?.createdAt && existingMeta.createdAt > 0) ? existingMeta.createdAt : now,
        updatedAt: now,
        charId: (existingMeta?.charId && existingMeta.charId.length > 0) ? existingMeta.charId : currentCharId,
        chatId: (existingMeta?.chatId && existingMeta.chatId.length > 0) ? existingMeta.chatId : currentChatId,
        imageGeneration: existingMeta?.imageGeneration,
    }
}

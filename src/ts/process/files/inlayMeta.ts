import { getCurrentCharacter } from "../../storage/database.svelte";
import { NodeStorage } from "../../storage/nodeStorage";

const INLAY_META_PREFIX = 'inlay_meta/'

export type InlayAssetMeta = {
    createdAt: number
    updatedAt: number
    charId?: string
    chatId?: string
    imageGeneration?: {
        prompt: string
        negativePrompt: string
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
            const raw = JSON.parse(new TextDecoder().decode(buf))
            const createdAt = typeof raw?.createdAt === 'number' ? raw.createdAt : 0
            const updatedAt = typeof raw?.updatedAt === 'number' ? raw.updatedAt : createdAt
            const charId = typeof raw?.charId === 'string' ? raw.charId : undefined
            const chatId = typeof raw?.chatId === 'string' ? raw.chatId : undefined
            const imageGeneration = parseImageGenerationMeta(raw?.imageGeneration)
            return { createdAt, updatedAt, charId, chatId, imageGeneration }
        } catch {
            return null
        }
    }

    async getItems(ids: string[]): Promise<Record<string, InlayAssetMeta>> {
        const result: Record<string, InlayAssetMeta> = {}
        if (!Array.isArray(ids) || ids.length === 0) return result
        try {
            const rows = await this.nodeStorage.getItems(ids.map((id) => this.serverKey(id)))
            for (const row of rows) {
                try {
                    const id = row.key.replace(INLAY_META_PREFIX, '')
                    const raw = JSON.parse(new TextDecoder().decode(row.value))
                    const createdAt = typeof raw?.createdAt === 'number' ? raw.createdAt : 0
                    const updatedAt = typeof raw?.updatedAt === 'number' ? raw.updatedAt : createdAt
                    const charId = typeof raw?.charId === 'string' ? raw.charId : undefined
                    const chatId = typeof raw?.chatId === 'string' ? raw.chatId : undefined
                    const imageGeneration = parseImageGenerationMeta(raw?.imageGeneration)
                    result[id] = { createdAt, updatedAt, charId, chatId, imageGeneration }
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

    async entries(): Promise<[string, InlayAssetMeta][]> {
        const allKeys = await this.nodeStorage.keys(INLAY_META_PREFIX)
        const ids = allKeys.map((k) => k.replace(INLAY_META_PREFIX, ''))
        const metas = await this.getItems(ids)
        return Object.entries(metas)
    }
}

function parseImageGenerationMeta(value: unknown): InlayAssetMeta['imageGeneration'] {
    if(!value || typeof value !== 'object') return undefined
    const data = value as Record<string, unknown>
    if(typeof data.prompt !== 'string' || typeof data.negativePrompt !== 'string') return undefined
    return { prompt: data.prompt, negativePrompt: data.negativePrompt }
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

export async function listInlayMetaEntries(): Promise<[string, InlayAssetMeta][]> {
    return await getStorage().entries()
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
    const currentChat = currentChar?.chats?.[currentChar?.chatPage ?? 0]
    const currentChatId = typeof currentChat?.id === 'string' ? currentChat.id : undefined

    return {
        createdAt: (existingMeta?.createdAt && existingMeta.createdAt > 0) ? existingMeta.createdAt : now,
        updatedAt: now,
        charId: (existingMeta?.charId && existingMeta.charId.length > 0) ? existingMeta.charId : currentCharId,
        chatId: (existingMeta?.chatId && existingMeta.chatId.length > 0) ? existingMeta.chatId : currentChatId,
        imageGeneration: existingMeta?.imageGeneration,
    }
}

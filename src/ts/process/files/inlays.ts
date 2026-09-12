import { Buffer } from 'buffer'
import { scanDatabaseContent } from "../../storage/scanDatabaseContent";
import { createEntityId } from 'src/ts/id';
import { getImageType } from "src/ts/media";
import { getDatabase } from "../../storage/database.svelte";
import { LLMFormat } from "src/ts/model/modellist";
import { getGenerationModelMetadata } from "../models/modelString";
import { asBuffer } from "../../util";
import { NodeStorage } from "../../storage/nodeStorage";
import {
    type InlayAssetMeta,
    buildInlayMeta,
    getInlayMeta,
    getInlayMetasBatch,
    removeInlayMeta,
    setInlayMeta,
} from "./inlayMeta";

export type InlayAsset = {
    data: string | Blob
    /** File extension */
    ext: string
    height?: number
    name: string
    type: 'image' | 'video' | 'audio' | 'signature'
    width?: number
}

/** Serialized form for server storage (Blob → base64 string) */
type SerializedInlayAsset = {
    data: string
    ext: string
    height?: number
    name: string
    type: 'image' | 'video' | 'audio' | 'signature'
    width?: number
}

export type InlayExplorerInfo = {
    ext: string
    height?: number
    name: string
    type: InlayAsset['type']
    width?: number
}

export type InlayExplorerItem = {
    ext: string
    hasMeta: boolean
    height?: number
    id: string
    meta: InlayAssetMeta | null
    name: string
    type: InlayAsset['type'] | 'unknown'
    width?: number
}

export type CharacterChatIndexItem = {
    chaId: string
    chats: {
        id: string
        name: string
    }[]
    name: string
}

export const INLAY_IMAGE_EXTENSIONS = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'
] as const

export const INLAY_AUDIO_EXTENSIONS = [
    'wav', 'mp3', 'ogg', 'flac'
] as const

export const INLAY_VIDEO_EXTENSIONS = [
    'webm', 'mp4', 'mkv'
] as const

export const INLAY_IMAGE_SIZE_PIXELS = {
    '1k': 1024 * 1024,
    '2k': 2048 * 2048,
    '4k': 4096 * 4096,
    'original': Number.POSITIVE_INFINITY,
} as const

export const INLAY_IMAGE_MAX_PIXELS = INLAY_IMAGE_SIZE_PIXELS['1k']

export function getInlayAssetUrl(id: string): string {
    return `/api/asset/${Buffer.from(`inlay/${id}`, 'utf-8').toString('hex')}`
}

export function getInlayVideoThumbnailUrl(id: string): string {
    return `/api/asset/${Buffer.from(`inlay_video_thumb/${id}`, 'utf-8').toString('hex')}`
}

export function getInlayThumbnailUrl(id: string): string {
    return `/api/asset/${Buffer.from(`inlay_thumb/${id}`, 'utf-8').toString('hex')}`
}

export function buildInlayReference(id: string): string {
    return `{{inlayed::${id}}}`
}

export function getInlayDownloadFileName(name: string, ext: string): string {
    const safeExt = ext.trim() || 'bin'
    const trimmedName = name.trim() || 'inlay-asset.bin'
    const lastDot = trimmedName.lastIndexOf('.')
    const withExtension = trimmedName.toLowerCase().endsWith(`.${safeExt.toLowerCase()}`)
        ? trimmedName
        : `${lastDot > 0 ? trimmedName.slice(0, lastDot) : trimmedName}.${safeExt}`
    return withExtension.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
}

export function fitInlayImageSize(
    width: number,
    height: number,
    maxPixels = INLAY_IMAGE_MAX_PIXELS,
): { width: number; height: number } {
    const currentPixels = width * height
    if (currentPixels <= maxPixels) return { width, height }
    const scaleFactor = Math.sqrt(maxPixels / currentPixels)
    return {
        width: Math.max(1, Math.floor(width * scaleFactor)),
        height: Math.max(1, Math.floor(height * scaleFactor)),
    }
}

const INLAY_PREFIX = 'inlay/'
const INLAY_INFO_PREFIX = 'inlay_info/'

// ── Memory LRU cache ──
type LRUEntry = {
    asset: InlayAsset
    lastAccessed: number
    size: number
}
const inlayLRUCache = new Map<string, LRUEntry>()
let totalLRUSize = 0

const MB = 1024 * 1024

function getNavigatorDeviceMemory(): number | undefined {
    if (typeof navigator === 'undefined') {
        return undefined
    }

    const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return undefined
    }

    return value
}

function getInlayCacheLimit(deviceMemory = getNavigatorDeviceMemory()): number {
    if (deviceMemory === undefined) {
        return 192 * MB
    }

    if (deviceMemory <= 2) {
        return 48 * MB
    }

    if (deviceMemory <= 4) {
        return 96 * MB
    }

    if (deviceMemory <= 8) {
        return 192 * MB
    }

    return 256 * MB
}

const INLAY_CACHE_LIMIT = getInlayCacheLimit()

function lruGet(id: string): InlayAsset | null {
    const entry = inlayLRUCache.get(id)
    if (!entry) return null
    entry.lastAccessed = Date.now()
    return entry.asset
}

function lruSet(id: string, asset: InlayAsset): void {
    const size = asset.data instanceof Blob ? asset.data.size : (asset.data as string).length
    const existing = inlayLRUCache.get(id)
    if (existing) totalLRUSize -= existing.size
    inlayLRUCache.set(id, { asset, lastAccessed: Date.now(), size })
    totalLRUSize += size
    // evict oldest entries if over limit
    if (totalLRUSize > INLAY_CACHE_LIMIT) {
        const sorted = [...inlayLRUCache.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
        for (const [key, entry] of sorted) {
            if (totalLRUSize <= INLAY_CACHE_LIMIT) break
            inlayLRUCache.delete(key)
            totalLRUSize -= entry.size
        }
    }
}

function lruDelete(id: string): void {
    const entry = inlayLRUCache.get(id)
    if (entry) {
        totalLRUSize -= entry.size
        inlayLRUCache.delete(id)
    }
}

/** @internal Reset module-level state for unit tests only */
export function __resetInlayStorageForTest(): void {
    inlayLRUCache.clear()
    totalLRUSize = 0
    _nodeInlayStorage = null
    _nodeInlayInfoStorage = null
}

// ── NodeInlayStorage ──

class NodeInlayStorage {
    private nodeStorage = new NodeStorage()

    async encodeWebp(data: Uint8Array, options: { lossy: boolean; quality: number }): Promise<Blob> {
        return await this.nodeStorage.encodeInlayWebp(data, options)
    }

    private serverKey(id: string): string {
        return `${INLAY_PREFIX}${id}`
    }

    private async serializeAsset(asset: InlayAsset): Promise<Uint8Array> {
        let dataStr: string
        if (asset.data instanceof Blob) {
            dataStr = await blobToBase64(asset.data)
        } else {
            dataStr = asset.data as string
        }
        const serialized: SerializedInlayAsset = {
            data: dataStr,
            ext: asset.ext,
            height: asset.height,
            name: asset.name,
            type: asset.type,
            width: asset.width,
        }
        return new TextEncoder().encode(JSON.stringify(serialized))
    }

    private deserializeAsset(buf: Buffer): InlayAsset {
        const json: SerializedInlayAsset = JSON.parse(new TextDecoder().decode(buf))
        let data: string | Blob
        if (json.type !== 'signature' && json.data.startsWith('data:')) {
            data = base64ToBlob(json.data)
        } else {
            data = json.data
        }
        return {
            data,
            ext: json.ext,
            height: json.height,
            name: json.name,
            type: json.type,
            width: json.width,
        }
    }

    async setItem(id: string, asset: InlayAsset): Promise<void> {
        const bytes = await this.serializeAsset(asset)
        await this.nodeStorage.setItem(this.serverKey(id), bytes)
        lruSet(id, toCoreInlayAsset(asset))
    }

    async getItem<T>(id: string): Promise<T | null> {
        // 1. Try memory LRU cache
        const cached = lruGet(id)
        if (cached) return cached as unknown as T

        // 2. Fetch from server
        try {
            const buf = await this.nodeStorage.getItem(this.serverKey(id))
            if (!buf || buf.length === 0) return null
            const asset = this.deserializeAsset(buf)
            lruSet(id, toCoreInlayAsset(asset))
            return asset as unknown as T
        } catch {
            return null
        }
    }

    async removeItem(id: string): Promise<void> {
        try {
            await this.nodeStorage.removeItem(this.serverKey(id))
            lruDelete(id)
        } catch {
            // ignore if not found
        }
    }

    async keys(): Promise<string[]> {
        const allKeys = await this.nodeStorage.keys(INLAY_PREFIX)
        return allKeys.map(k => k.replace(INLAY_PREFIX, ''))
    }

    async iterate<T, U>(callback: (value: T, key: string, iterationNumber: number) => U): Promise<U> {
        const allKeys = await this.nodeStorage.keys(INLAY_PREFIX)
        let result: U
        let i = 0
        for (const decodedKey of allKeys) {
            const id = decodedKey.replace(INLAY_PREFIX, '')
            try {
                const buf = await this.nodeStorage.getItem(decodedKey)
                if (buf && buf.length > 0) {
                    const asset = this.deserializeAsset(buf)
                    result = callback(asset as unknown as T, id, i)
                    i++
                }
            } catch {
                // skip corrupt entries
            }
        }
        return result
    }
}

// ── NodeInlayInfoStorage ──

class NodeInlayInfoStorage {
    private nodeStorage = new NodeStorage()

    private serverKey(id: string): string {
        return `${INLAY_INFO_PREFIX}${id}`
    }

    async setItem(id: string, info: InlayExplorerInfo): Promise<void> {
        const bytes = new TextEncoder().encode(JSON.stringify(info))
        await this.nodeStorage.setItem(this.serverKey(id), bytes)
    }

    async getItem<T>(id: string): Promise<T | null> {
        try {
            const buf = await this.nodeStorage.getItem(this.serverKey(id))
            if (!buf || buf.length === 0) return null
            return JSON.parse(new TextDecoder().decode(buf)) as T
        } catch {
            return null
        }
    }

    async getItems<T>(ids: string[]): Promise<Record<string, T>> {
        const result: Record<string, T> = {}
        if (!Array.isArray(ids) || ids.length === 0) return result
        try {
            const rows = await this.nodeStorage.getItems(ids.map((id) => this.serverKey(id)))
            for (const row of rows) {
                try {
                    const id = row.key.replace(INLAY_INFO_PREFIX, '')
                    result[id] = JSON.parse(new TextDecoder().decode(row.value)) as T
                } catch {
                    // skip corrupt explorer info entries
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
            // ignore if not found
        }
    }
}

function toCoreInlayAsset(asset: any): InlayAsset {
    return {
        data: asset.data,
        ext: asset.ext,
        height: asset.height,
        name: asset.name,
        type: asset.type,
        width: asset.width,
    }
}

// ── Storage instance singletons ──

let _nodeInlayStorage: NodeInlayStorage | null = null
let _nodeInlayInfoStorage: NodeInlayInfoStorage | null = null

function getInlayStorage(): NodeInlayStorage {
    if (!_nodeInlayStorage) _nodeInlayStorage = new NodeInlayStorage()
    return _nodeInlayStorage
}

function getInlayInfoStorage(): NodeInlayInfoStorage {
    if (!_nodeInlayInfoStorage) _nodeInlayInfoStorage = new NodeInlayInfoStorage()
    return _nodeInlayInfoStorage
}

export { getInlayMeta } from "./inlayMeta";

// ── Helpers ──

function base64ToBlob(b64: string): Blob {
    const splitDataURI = b64.split(',');
    const byteString = atob(splitDataURI[1]);
    const mimeString = splitDataURI[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeString });
}

function blobToBase64(blob: Blob): Promise<string> {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise<string>((resolve, reject) => {
        reader.onloadend = () => { resolve(reader.result as string); };
        reader.onerror = reject;
    });
}

function buildInlayExplorerInfo(asset: InlayAsset): InlayExplorerInfo {
    return {
        ext: asset.ext,
        height: asset.height,
        name: asset.name,
        type: asset.type,
        width: asset.width,
    }
}

function buildExplorerItem(
    id: string,
    info: InlayExplorerInfo | null,
    meta: InlayAssetMeta | null
): InlayExplorerItem {
    return {
        ext: info?.ext ?? '',
        hasMeta: meta !== null,
        height: info?.height,
        id,
        meta,
        name: info?.name ?? id,
        type: info?.type ?? 'image',
        width: info?.width,
    }
}

function getSafeChatName(name: unknown, fallbackId: string, index: number): string {
    if (typeof name === 'string' && name.trim().length > 0) return name
    if (fallbackId.trim().length > 0) return fallbackId
    return `Chat ${index + 1}`
}

function getSafeCharacterName(name: unknown, fallbackId: string, index: number): string {
    if (typeof name === 'string' && name.trim().length > 0) return name
    if (fallbackId.trim().length > 0) return fallbackId
    return `Character ${index + 1}`
}

// ── Public API ──

export async function postInlayAsset(img: { name: string, data: Uint8Array }) {
    const extention = img.name.split('.').at(-1)
    const imgObj = new Image()

    if (INLAY_IMAGE_EXTENSIONS.includes(extention as typeof INLAY_IMAGE_EXTENSIONS[number])) {
        imgObj.src = URL.createObjectURL(new Blob([asBuffer(img.data)], { type: `image/${extention}` }))
        return await writeInlayImage(imgObj, { name: img.name, ext: extention })
    }

    if (INLAY_AUDIO_EXTENSIONS.includes(extention as typeof INLAY_AUDIO_EXTENSIONS[number])) {
        const audioBlob = new Blob([asBuffer(img.data)], { type: `audio/${extention}` })
        const imgid = createEntityId()
        await setInlayAsset(imgid, { name: img.name, data: audioBlob, ext: extention, type: 'audio' })
        return `${imgid}`
    }

    if (INLAY_VIDEO_EXTENSIONS.includes(extention as typeof INLAY_VIDEO_EXTENSIONS[number])) {
        const videoBlob = new Blob([asBuffer(img.data)], { type: `video/${extention}` })
        const imgid = createEntityId()
        await setInlayAsset(imgid, { name: img.name, data: videoBlob, ext: extention, type: 'video' })
        return `${imgid}`
    }

    return null
}

export async function writeInlayImage(imgObj: HTMLImageElement, arg: { name?: string, ext?: string, id?: string } = {}) {
    let drawHeight = 0
    let drawWidth = 0
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const db = getDatabase()
    const compressionEnabled = db.inlayImageCompression
    const size = compressionEnabled ? (db.inlayImageSize ?? '1k') : 'original'
    const maxPixels = INLAY_IMAGE_SIZE_PIXELS[size]
    await new Promise((resolve) => {
        imgObj.onload = () => {
            const fitted = fitInlayImageSize(imgObj.width, imgObj.height, maxPixels)
            drawHeight = fitted.height
            drawWidth = fitted.width
            canvas.width = drawWidth
            canvas.height = drawHeight
            ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
            resolve(null)
        }
    })
    const ext = compressionEnabled ? (db.inlayImageFormat ?? 'webp') : 'png'
    const pngBlob = await new Promise<Blob>(resolve => canvas.toBlob(resolve, 'image/png', 1))
    const imageBlob = compressionEnabled && ext === 'webp'
        ? await getInlayStorage().encodeWebp(
            new Uint8Array(await pngBlob.arrayBuffer()),
            {
                lossy: db.inlayImageLossy ?? true,
                quality: db.inlayImageQuality ?? 0.85,
            },
        )
        : pngBlob
    const imgid = arg.id ?? createEntityId()
    await setInlayAsset(imgid, { name: arg.name ?? imgid, data: imageBlob, ext, height: drawHeight, width: drawWidth, type: 'image' })
    return `${imgid}`
}

export type InlaySignature = {
    signatures: {
        type: 'function' | 'text'
        content: string
    }[],
    sourceFormat: LLMFormat,
    source: string
}

export async function saveInlayedSignature(sigid: string, signature: InlaySignature) {
    await setInlayAsset(sigid, {
        name: sigid,
        data: JSON.stringify(signature),
        ext: 'json',
        type: 'signature'
    } satisfies InlayAsset)
    return sigid
}

// Returns with base64 data URI
export async function getInlayAsset(id: string) {
    const img = await getInlayStorage().getItem<InlayAsset | null>(id)
    if (img === null) return null
    let data: string
    if (img.data instanceof Blob) {
        data = await blobToBase64(img.data)
    } else {
        data = img.data as string
    }
    const existingInfo = await getInlayInfoStorage().getItem<InlayExplorerInfo>(id)
    if (!existingInfo) {
        await getInlayInfoStorage().setItem(id, buildInlayExplorerInfo(toCoreInlayAsset(img)))
    }
    return { ...toCoreInlayAsset(img), data }
}

// Returns with Blob
export async function getInlayAssetBlob(id: string) {
    const img = await getInlayStorage().getItem<InlayAsset | null>(id)
    if (img === null) return null
    let data: Blob
    if (typeof img.data === 'string') {
        data = base64ToBlob(img.data)
        await setInlayAsset(id, { ...toCoreInlayAsset(img), data })
    } else {
        data = img.data
        const existingInfo = await getInlayInfoStorage().getItem<InlayExplorerInfo>(id)
        if (!existingInfo) {
            await getInlayInfoStorage().setItem(id, buildInlayExplorerInfo(toCoreInlayAsset(img)))
        }
    }
    return { ...toCoreInlayAsset(img), data }
}

export async function listInlayAssets(): Promise<[id: string, InlayAsset][]> {
    const assets: [id: string, InlayAsset][] = []
    await getInlayStorage().iterate<InlayAsset, void>((value, key) => {
        assets.push([key, toCoreInlayAsset(value)])
    })
    return assets
}

export async function listInlayKeys(): Promise<string[]> {
    return await getInlayStorage().keys()
}

export function getCharacterChatIndex(): CharacterChatIndexItem[] {
    const db = getDatabase()
    const characters = Array.isArray(db?.characters) ? db.characters : []
    const result: CharacterChatIndexItem[] = []
    for (let i = 0; i < characters.length; i++) {
        const char = characters[i]
        const chaId = typeof char?.chaId === 'string' ? char.chaId : ''
        if (!chaId) continue
        const chats = Array.isArray(char?.chats) ? char.chats : []
        result.push({
            chaId,
            chats: chats
                .map((chat, chatIndex) => {
                    const id = typeof chat?.id === 'string' ? chat.id : ''
                    if (!id) return null
                    return {
                        id,
                        name: getSafeChatName(chat?.name, id, chatIndex),
                    }
                })
                .filter((chat): chat is CharacterChatIndexItem['chats'][number] => chat !== null),
            name: getSafeCharacterName(char?.name, chaId, i),
        })
    }
    return result
}

/**
 * Lightweight explorer list for the inlay gallery.
 * Use `getInlayAssetBlob(id)` on demand when the user opens or downloads the original file.
 */
// Gallery metadata cache — avoids re-fetching on gallery re-entry
let _explorerItemsCache: InlayExplorerItem[] | null = null
let _explorerItemsCacheTime = 0
const EXPLORER_CACHE_TTL = 30_000 // 30 seconds

export async function listInlayExplorerItems(forceRefresh = false): Promise<InlayExplorerItem[]> {
    if (!forceRefresh && _explorerItemsCache && Date.now() - _explorerItemsCacheTime < EXPLORER_CACHE_TTL) {
        return _explorerItemsCache
    }

    const ids = await listInlayKeys()
    if (ids.length === 0) {
        _explorerItemsCache = []
        _explorerItemsCacheTime = Date.now()
        return []
    }

    const itemMap = await getInlayExplorerItemsBatch(ids)
    const items = ids.map((id) => itemMap[id])

    _explorerItemsCache = items
    _explorerItemsCacheTime = Date.now()
    return items
}

export async function getInlayExplorerItemsBatch(ids: string[]): Promise<Record<string, InlayExplorerItem>> {
    if (!Array.isArray(ids) || ids.length === 0) return {}
    const [infos, metas] = await Promise.all([
        getInlayInfoStorage().getItems<InlayExplorerInfo>(ids),
        getInlayMetas(ids),
    ])
    return Object.fromEntries(ids.map(id => [
        id,
        buildExplorerItem(id, infos[id] ?? null, metas[id] ?? null),
    ]))
}

export async function setInlayAsset(id: string, img: InlayAsset) {
    const existingMeta = await getInlayMeta(id)
    const nextMeta = buildInlayMeta(existingMeta)
    await getInlayStorage().setItem(id, toCoreInlayAsset(img))
    await getInlayInfoStorage().setItem(id, buildInlayExplorerInfo(toCoreInlayAsset(img)))
    await setInlayMeta(id, nextMeta)
    _explorerItemsCache = null // invalidate gallery cache
}

export async function removeInlayAsset(id: string) {
    await getInlayStorage().removeItem(id)
    await getInlayInfoStorage().removeItem(id)
    await removeInlayMeta(id)
    _explorerItemsCache = null // invalidate gallery cache
}

export async function removeInlayAssets(ids: string[]): Promise<number> {
    if (!Array.isArray(ids) || ids.length === 0) return 0
    let removed = 0
    for (const id of ids) {
        if (!id) continue
        try {
            await removeInlayAsset(id)
            removed++
        } catch {
            // best-effort bulk delete
        }
    }
    return removed
}

export async function setInlayMetaFields(
    id: string,
    patch: Partial<Pick<InlayAssetMeta, 'charId' | 'chatId' | 'createdAt' | 'updatedAt' | 'imageGeneration'>>
): Promise<void> {
    const existing = await getInlayMeta(id)
    const now = Date.now()
    const next: InlayAssetMeta = {
        createdAt: (typeof patch.createdAt === 'number' && patch.createdAt > 0)
            ? patch.createdAt
            : (existing?.createdAt && existing.createdAt > 0 ? existing.createdAt : now),
        updatedAt: (typeof patch.updatedAt === 'number' && patch.updatedAt > 0) ? patch.updatedAt : now,
        charId: typeof patch.charId === 'string' ? patch.charId : existing?.charId,
        chatId: typeof patch.chatId === 'string' ? patch.chatId : existing?.chatId,
        imageGeneration: patch.imageGeneration ?? existing?.imageGeneration,
    }
    await setInlayMeta(id, next)
}

export async function getInlayMetas(ids: string[]): Promise<Record<string, InlayAssetMeta>> {
    if (!Array.isArray(ids) || ids.length === 0) return {}
    return await getInlayMetasBatch(ids)
}

export async function getInlayInfosBatch(ids: string[]): Promise<Record<string, InlayExplorerInfo>> {
    if (!Array.isArray(ids) || ids.length === 0) return {}
    return await getInlayInfoStorage().getItems<InlayExplorerInfo>(ids)
}

export type InlayScanResult = {
    scannedAt: number
    totalMessages: number
    refCounts: Record<string, number>
}

/** Server references plus local unsaved references, shared with cache cleanup. */
export async function scanInlayReferences(candidates: string[]): Promise<InlayScanResult> {
    return await scanDatabaseContent('inlay', candidates)
}

export function supportsInlayImage() {
    return getGenerationModelMetadata('model').vision
}

export async function reencodeImage(img: Uint8Array) {
    if (getImageType(img) === 'PNG') return img
    const canvas = document.createElement('canvas')
    const imgObj = new Image()
    imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], { type: `image/png` }))
    await imgObj.decode()
    let drawHeight = imgObj.height
    let drawWidth = imgObj.width
    canvas.width = drawWidth
    canvas.height = drawHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
    const b64 = canvas.toDataURL('image/png').split(',')[1]
    const b = Buffer.from(b64, 'base64')
    return b
}

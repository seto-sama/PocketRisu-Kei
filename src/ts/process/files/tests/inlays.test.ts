import { Buffer } from 'buffer'
import fc from 'fast-check'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { encodeInlayAsset, decodeInlayAsset } from '../../../storage/inlayTransport'
import type { InlayAsset } from '../inlays'

let inlays!: typeof import('../inlays')

describe('inlay viewer helpers', () => {
    test('builds canonical references and direct asset URLs', () => {
        expect(inlays.buildInlayReference('asset-id')).toBe('{{inlayed::asset-id}}')
        expect(inlays.getInlayAssetUrl('asset-id')).toBe('/api/asset/696e6c61792f61737365742d6964')
    })

    test('normalizes download names and replaces unsafe characters', () => {
        expect(inlays.getInlayDownloadFileName('image.jpg', 'png')).toBe('image.png')
        expect(inlays.getInlayDownloadFileName('bad/name', 'webp')).toBe('bad_name.webp')
        expect(inlays.getInlayDownloadFileName('', 'png')).toBe('inlay-asset.png')
    })
})

const { scanReferencesMock } = vi.hoisted(() => ({ scanReferencesMock: vi.fn() }))
const { createVideoThumbnailMock, saveVideoThumbnailMock } = vi.hoisted(() => ({
    createVideoThumbnailMock: vi.fn(),
    saveVideoThumbnailMock: vi.fn(),
}))
vi.mock('../videoThumbnail', () => ({ createVideoThumbnail: createVideoThumbnailMock }))

// happy-dom canvas getContext returns null
const fakeCtx = {
    drawImage: vi.fn(),
}
const origCreateElement = document.createElement.bind(document)
vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: any) => {
    const el = origCreateElement(tag, options)
    if (tag === 'canvas') {
        ;(el as HTMLCanvasElement).getContext = (() => fakeCtx) as any
        ;(el as HTMLCanvasElement).toBlob = ((cb: BlobCallback, type?: string) => {
            cb(new Blob(['fake-image'], { type: type || 'image/png' }))
        }) as any
    }
    return el
})

const { nodeStorageMap, inlayMetaMap } = vi.hoisted(() => ({
    nodeStorageMap: new Map<string, Uint8Array>(),
    inlayMetaMap: new Map<string, any>(),
}))

vi.mock('src/ts/storage/nodeStorage', () => {
    class MockConflictError extends Error {
        currentEtag: string

        constructor(message: string, currentEtag: string) {
            super(message)
            this.name = 'ConflictError'
            this.currentEtag = currentEtag
        }
    }

    class MockNodeStorage {
        authChecked = true
        scanContentReferences = scanReferencesMock
        saveInlayVideoThumbnail = saveVideoThumbnailMock
        async setItem(key: string, value: Uint8Array) {
            nodeStorageMap.set(key, value)
        }
        async encodeInlayWebp() {
            return new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'image/webp' })
        }
        async getItem(key: string) {
            return nodeStorageMap.get(key) ?? null
        }
        async removeItem(key: string) {
            nodeStorageMap.delete(key)
        }
        async keys(prefix = '') {
            const ks = [...nodeStorageMap.keys()]
            return prefix ? ks.filter(k => k.startsWith(prefix)) : ks
        }
        async getItems(keys: string[]) {
            return keys
                .filter((key) => nodeStorageMap.has(key))
                .map((key) => ({ key, value: Buffer.from(nodeStorageMap.get(key)!) }))
        }
        async setItems(entries: {key: string, value: Uint8Array}[]) {
            for (const entry of entries) {
                nodeStorageMap.set(entry.key, entry.value)
            }
        }
        listItem = this.keys
    }
    return {
        ConflictError: MockConflictError,
        getSyncClientId: vi.fn(() => 'test-sync-client-id'),
        NodeStorage: MockNodeStorage,
    }
})

vi.mock('src/ts/process/files/inlayMeta', () => ({
    getInlayMeta: vi.fn(async (id: string) => inlayMetaMap.get(id) ?? null),
    getInlayMetasBatch: vi.fn(async (ids: string[]) => Object.fromEntries(
        ids
            .filter((id) => inlayMetaMap.has(id))
            .map((id) => [id, inlayMetaMap.get(id)])
    )),
    setInlayMeta: vi.fn(async (id: string, meta: any) => { inlayMetaMap.set(id, meta) }),
    removeInlayMeta: vi.fn(async (id: string) => { inlayMetaMap.delete(id) }),
    buildInlayMeta: vi.fn((existing: any) => ({
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
    })),
}))

vi.mock('uuid', () => ({
    v4: vi.fn(() => 'test-uuid-1234'),
}))

const { getDatabaseMock } = vi.hoisted(() => ({
    getDatabaseMock: vi.fn<() => any>(() => ({
        characters: [],
        inlayImageCompression: true,
        inlayImageSize: '1k',
        inlayImageFormat: 'webp',
        inlayImageLossy: true,
        inlayImageQuality: 0.85,
    })),
}))

vi.mock(import('src/ts/storage/database.svelte'), () => ({
    getDatabase: getDatabaseMock,
    getCurrentCharacter: vi.fn(() => null),
    getCurrentChat: vi.fn(() => null),
}))

vi.mock(
    import('src/ts/util'),
    () =>
        ({
            asBuffer: (arr: Uint8Array) => arr,
            // Transitive store imports also require this export.
            checkPersonaBinded: () => null,
        }) as typeof import('src/ts/util'),
)

function makeImage(w: number, h: number): HTMLImageElement {
    const img = new Image()
    Object.defineProperty(img, 'width', { get: () => w })
    Object.defineProperty(img, 'height', { get: () => h })
    Object.defineProperty(img, 'onload', {
        set(fn: () => void) {
            fn?.()
        },
        get() {
            return null
        },
    })
    return img
}

beforeEach(async () => {
    vi.clearAllMocks()
    createVideoThumbnailMock.mockReset().mockResolvedValue(null)
    saveVideoThumbnailMock.mockReset().mockResolvedValue(undefined)
    nodeStorageMap.clear()
    inlayMetaMap.clear()
    getDatabaseMock.mockReturnValue({
        characters: [],
        inlayImageCompression: true,
        inlayImageSize: '1k',
        inlayImageFormat: 'webp',
        inlayImageLossy: true,
        inlayImageQuality: 0.85,
    })
    vi.resetModules()
    inlays = await import('../inlays')
})

describe('setInlayAsset', () => {
    test('overwrites an existing asset with the same id', async () => {
        const first: InlayAsset = {
            data: new Blob(['a']),
            ext: 'png',
            height: 10,
            name: 'first.png',
            type: 'image',
            width: 10,
        }
        const second: InlayAsset = {
            data: new Blob(['b']),
            ext: 'png',
            height: 20,
            name: 'second.png',
            type: 'image',
            width: 20,
        }

        await inlays.setInlayAsset('id-1', first)
        await inlays.setInlayAsset('id-1', second)

        const stored = await inlays.getInlayAsset('id-1')
        expect(stored).toMatchObject({
            height: 20,
            name: 'second.png',
            type: 'image',
            width: 20,
        })
    })
})

describe('getInlayAsset', () => {
    test('returns asset with base64 data URI when stored as Blob', async () => {
        const blob = new Blob(['test-data'], { type: 'text/plain' })
        const asset: InlayAsset = {
            data: blob,
            ext: 'png',
            height: 50,
            width: 50,
            name: 'blob-asset.png',
            type: 'image',
        }
        await inlays.setInlayAsset('blob-id', asset)

        const result = await inlays.getInlayAsset('blob-id')

        expect(result!.data).toMatch(/^data:/)
        expect(result!.name).toBe('blob-asset.png')
    })
})

describe('getInlayAssetBlob', () => {
    test('roundtrips binary media through storage without a cached Blob', async () => {
        const bytes = new Uint8Array([0, 255, 128, 1])
        await inlays.setInlayAsset('blob-id', {
            data: new Blob([bytes], { type: 'image/png' }),
            ext: 'png', height: 64, width: 64, name: 'blob.png', type: 'image',
        })
        const wire = decodeInlayAsset(nodeStorageMap.get('inlay/blob-id')!)
        expect(wire.bytes).toEqual(bytes)
        expect(wire.metadata).toMatchObject({ mime: 'image/png', name: 'blob.png' })
        vi.resetModules()
        inlays = await import('../inlays')
        const result = await inlays.getInlayAssetBlob('blob-id')
        expect(result!.data.type).toBe('image/png')
        expect(new Uint8Array(await result!.data.arrayBuffer())).toEqual(bytes)
    })

})

describe('getCharacterChatIndex', () => {
    test('returns lightweight character/chat index with valid ids only', () => {
        getDatabaseMock.mockReturnValue({
            characters: [
                {
                    chaId: 'char-1',
                    chats: [
                        { id: 'chat-1', name: 'First Chat' },
                        { id: 'chat-2', name: '' },
                        { name: 'Missing Id Chat' },
                    ],
                    name: 'Alice',
                },
                {
                    chaId: 'char-2',
                    chats: [{ id: 'chat-3', name: 'Third Chat' }],
                    name: '',
                },
                {
                    chats: [{ id: 'chat-4', name: 'Should Skip' }],
                    name: 'No Id',
                },
            ],
        })

        expect(inlays.getCharacterChatIndex()).toEqual([
            {
                chaId: 'char-1',
                chats: [
                    { id: 'chat-1', name: 'First Chat' },
                    { id: 'chat-2', name: 'chat-2' },
                ],
                name: 'Alice',
            },
            {
                chaId: 'char-2',
                chats: [{ id: 'chat-3', name: 'Third Chat' }],
                name: 'char-2',
            },
        ])
    })
})

describe('listInlayExplorerItems', () => {
    test('returns lightweight explorer items without loading full asset body', async () => {
        inlayMetaMap.set('img-1', {
            charId: 'char-1',
            chatId: 'chat-1',
            createdAt: 10,
            updatedAt: 20,
        })

        await inlays.setInlayAsset('img-1', {
            data: new Blob(['img-data'], { type: 'image/png' }),
            ext: 'png',
            height: 128,
            name: 'thumb-image.png',
            type: 'image',
            width: 256,
        })

        const infoOnlyValue = new TextEncoder().encode(JSON.stringify({
            ext: 'mp3',
            name: 'audio-file.mp3',
            type: 'audio',
        }))
        nodeStorageMap.set('inlay/audio-1', encodeInlayAsset({
            mime: 'audio/mp3',
            ext: 'mp3',
            name: 'audio-file.mp3',
            type: 'audio',
        }, new Uint8Array([97])))
        nodeStorageMap.set('inlay_info/audio-1', infoOnlyValue)

        const result = await inlays.listInlayExplorerItems()
        const byId = Object.fromEntries(result.map((item) => [item.id, item]))

        expect(byId['img-1']).toMatchObject({
            ext: 'png',
            hasMeta: true,
            name: 'thumb-image.png',
            type: 'image',
        })

        expect(byId['audio-1']).toMatchObject({
            ext: 'mp3',
            hasMeta: false,
            name: 'audio-file.mp3',
            type: 'audio',
        })
    })
})

describe('postInlayAsset', () => {
    test.each(['notes.txt', 'clip.mp4.exe', 'no-extension'])('rejects unsupported file name %s', async (name) => {
        expect(await inlays.postInlayAsset({ name, data: new Uint8Array([0x00]) })).toBeNull()
    })

    test('routes supported audio files to audio storage', async () => {
        for (const ext of inlays.INLAY_AUDIO_EXTENSIONS) {
            const result = await inlays.postInlayAsset({ name: `sound.${ext}`, data: new Uint8Array([0x00]) })
            expect(await inlays.getInlayAssetBlob(result!)).toMatchObject({ ext, type: 'audio' })
        }
    })

    test('routes supported video files to video storage', async () => {
        for (const ext of inlays.INLAY_VIDEO_EXTENSIONS) {
            const result = await inlays.postInlayAsset({ name: `clip.${ext}`, data: new Uint8Array([0x00]) })
            expect(await inlays.getInlayAssetBlob(result!)).toMatchObject({ ext, type: 'video' })
        }
    })

    test('saves the browser-generated video thumbnail with the uploaded asset', async () => {
        const thumbnail = new Blob(['frame'], { type: 'image/png' })
        createVideoThumbnailMock.mockResolvedValueOnce(thumbnail)
        const id = await inlays.postInlayAsset({ name: 'clip.mp4', data: new Uint8Array([1, 2]) })
        expect(saveVideoThumbnailMock).toHaveBeenCalledWith(id, thumbnail)
        expect(await inlays.getInlayAssetBlob(id!)).toMatchObject({ type: 'video', name: 'clip.mp4' })
    })

    test('keeps the original video when saving its thumbnail fails', async () => {
        createVideoThumbnailMock.mockResolvedValueOnce(new Blob(['frame'], { type: 'image/png' }))
        saveVideoThumbnailMock.mockRejectedValueOnce(new Error('Network failure'))
        const id = await inlays.postInlayAsset({ name: 'clip.mp4', data: new Uint8Array([1, 2]) })
        expect(await inlays.getInlayAssetBlob(id!)).toMatchObject({ type: 'video', name: 'clip.mp4' })
    })
})

describe('fitInlayImageSize', () => {
    const maxPixels = 1024 * 1024

    test('keeps dimensions inside the pixel budget unchanged', () => {
        fc.assert(fc.property(
            fc.integer({ min: 1, max: 1024 }),
            fc.integer({ min: 1, max: 1024 }),
            (width, height) => {
                expect(inlays.fitInlayImageSize(width, height, maxPixels)).toEqual({ width, height })
            },
        ))
    })

    test('fits large images within the budget while preserving their aspect ratio', () => {
        fc.assert(fc.property(
            fc.integer({ min: 1, max: 10_000 }),
            fc.integer({ min: 1, max: 10_000 }),
            (width, height) => {
                const fitted = inlays.fitInlayImageSize(width, height, maxPixels)
                expect(fitted.width * fitted.height).toBeLessThanOrEqual(maxPixels)
                expect(fitted.width).toBeGreaterThan(0)
                expect(fitted.height).toBeGreaterThan(0)
                if (width * height > maxPixels) {
                    expect(Math.abs(width / height - fitted.width / fitted.height) / (width / height)).toBeLessThan(0.01)
                }
            },
        ))
    })

    test('keeps the 1216 x 832 NAI default inside the 1K pixel budget', () => {
        expect(inlays.fitInlayImageSize(1216, 832, maxPixels)).toEqual({
            width: 1216,
            height: 832,
        })
    })
})

describe('writeInlayImage', () => {
    test('stores image asset with correct metadata and returns id', async () => {
        const imgObj = makeImage(200, 100)

        const result = await inlays.writeInlayImage(imgObj, {
            name: 'photo.jpg',
            ext: 'jpg',
            id: 'custom-id',
        })

        expect(result).toBe('custom-id')

        const stored = await inlays.getInlayAssetBlob('custom-id')
        expect(stored).toMatchObject({
            data: expect.any(Blob),
            ext: 'webp',
            height: 100,
            name: 'photo.jpg',
            type: 'image',
            width: 200,
        })
    })

    test('stores the original-size image as PNG when compression is disabled', async () => {
        getDatabaseMock.mockReturnValue({ characters: [], inlayImageCompression: false })
        const imgObj = makeImage(200, 100)

        const result = await inlays.writeInlayImage(imgObj, {
            name: 'photo.jpg',
            ext: 'jpg',
            id: 'lossless-id',
        })

        expect(result).toBe('lossless-id')

        const stored = await inlays.getInlayAssetBlob('lossless-id')
        expect(stored).toMatchObject({
            data: expect.any(Blob),
            ext: 'png',
            height: 100,
            name: 'photo.jpg',
            type: 'image',
            width: 200,
        })
    })

    test('uses the configured PNG format and 2K size budget', async () => {
        getDatabaseMock.mockReturnValue({
            characters: [],
            inlayImageCompression: true,
            inlayImageSize: '2k',
            inlayImageFormat: 'png',
            inlayImageLossy: true,
            inlayImageQuality: 0.85,
        })
        const imgObj = makeImage(3000, 2000)

        await inlays.writeInlayImage(imgObj, { id: 'png-2k' })

        const stored = await inlays.getInlayAssetBlob('png-2k')
        expect(stored).toMatchObject({ ext: 'png', type: 'image' })
        expect(stored!.width! * stored!.height!).toBeLessThanOrEqual(2048 * 2048)
    })

    test('generates uuid when no id is provided', async () => {
        const imgObj = makeImage(50, 50)

        const result = await inlays.writeInlayImage(imgObj)
        expect(result).toBe('test-uuid-1234')

        const stored = await inlays.getInlayAssetBlob('test-uuid-1234')
        expect(stored!.name).toBe('test-uuid-1234')
    })

})

describe('set -> get round-trip', () => {
    test('preserves metadata through setInlayAsset -> getInlayAsset', async () => {
        const asset: InlayAsset = {
            data: new Blob(['data'], { type: 'application/octet-stream' }),
            ext: 'custom', height: 480, width: 640, name: 'named asset', type: 'image',
        }
        await inlays.setInlayAsset('metadata-round-trip', asset)
        expect(await inlays.getInlayAsset('metadata-round-trip')).toMatchObject({
            data: expect.any(String), ext: 'custom', height: 480, width: 640,
            name: 'named asset', type: 'image',
        })
    })
})

describe('set -> remove -> get', () => {
    test('removes a stored asset from cache and persistence', async () => {
        const id = 'remove-round-trip'
        await inlays.setInlayAsset(id, {
            data: new Blob(['x']), ext: 'png', height: 1, width: 1, name: 'tmp.png', type: 'image',
        })
        expect(await inlays.getInlayAsset(id)).not.toBeNull()
        await inlays.removeInlayAsset(id)
        expect(await inlays.getInlayAsset(id)).toBeNull()
    })
})


describe('inlay reference scan', () => {
    test('protects references in unopened chats, alternate greetings, swipes and summaries', async () => {
        getDatabaseMock.mockReturnValue({ characters: [{ chaId: 'char',
            firstMessage: '{{inlay::greeting}}', alternateGreetings: ['{{inlayed::alternate}}'],
            chats: [{ id: 'unopened', _placeholder: true, message: [] }],
        }] })
        scanReferencesMock.mockResolvedValue({ kind: 'inlay', scannedAt: 1, totalMessages: 1, refCounts: { used: 1, swipe: 1, summary: 1 } })
        expect((await inlays.scanInlayReferences(['used', 'swipe', 'summary', 'new-reference'])).refCounts).toEqual({ greeting: 1, alternate: 1, used: 1, swipe: 1, summary: 1 })
        scanReferencesMock.mockResolvedValue({ kind: 'inlay', scannedAt: 2, totalMessages: 1, refCounts: { 'new-reference': 1 } })
        expect((await inlays.scanInlayReferences(['used', 'swipe', 'summary', 'new-reference'])).refCounts['new-reference']).toBe(1)
    })
    test('never classifies assets as unused after an incomplete scan', async () => {
        getDatabaseMock.mockReturnValue({ characters: [{ chaId: 'char', chats: [{ id: 'unopened', _placeholder: true }] }] })
        scanReferencesMock.mockRejectedValue(new Error('offline'))
        await expect(inlays.scanInlayReferences(['used', 'swipe', 'summary', 'new-reference'])).rejects.toThrow('offline')
    })
})

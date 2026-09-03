import fc from 'fast-check'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { InlayAsset } from '../inlays'
import {
    fitInlayImageSize,
    getInlayAsset,
    getInlayAssetBlob,
    getCharacterChatIndex,
    INLAY_AUDIO_EXTENSIONS,
    INLAY_IMAGE_MAX_PIXELS,
    INLAY_VIDEO_EXTENSIONS,
    listInlayExplorerItems,
    postInlayAsset,
    removeInlayAsset,
    setInlayAsset,
    writeInlayImage,
    __resetInlayStorageForTest,
} from '../inlays'

//#region module mocks

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
        async setItem(key: string, value: Uint8Array) {
            nodeStorageMap.set(key, value)
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
    listInlayMetaEntries: vi.fn(async () => [...inlayMetaMap.entries()]),
}))

vi.mock('uuid', () => ({
    v4: vi.fn(() => 'test-uuid-1234'),
}))

const { getDatabaseMock } = vi.hoisted(() => ({
    getDatabaseMock: vi.fn<() => any>(() => ({ characters: [] })),
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
            // modules.ts (pulled in via the stores $effect) imports this from util
            checkPersonaBinded: () => null,
        }) as typeof import('src/ts/util'),
)

//#endregion

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

beforeEach(() => {
    vi.clearAllMocks()
    nodeStorageMap.clear()
    inlayMetaMap.clear()
    getDatabaseMock.mockReturnValue({ characters: [] })
    __resetInlayStorageForTest()
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

        await setInlayAsset('id-1', first)
        await setInlayAsset('id-1', second)

        const stored = await getInlayAsset('id-1')
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
        await setInlayAsset('blob-id', asset)

        const result = await getInlayAsset('blob-id')

        expect(result!.data).toMatch(/^data:/)
        expect(result!.name).toBe('blob-asset.png')
    })

    test('returns asset with string data as-is when stored as string', async () => {
        const b64 = 'data:image/png;base64,aGVsbG8='
        const asset: InlayAsset = {
            data: b64,
            ext: 'png',
            height: 50,
            width: 50,
            name: 'string-asset.png',
            type: 'image',
        }
        await setInlayAsset('str-id', asset)

        const result = await getInlayAsset('str-id')
        expect(result!.data).toBe(b64)
    })
})

describe('getInlayAssetBlob', () => {
    test('returns Blob data when stored as Blob', async () => {
        const blob = new Blob(['binary-data'], { type: 'image/png' })
        const asset: InlayAsset = {
            data: blob,
            ext: 'png',
            height: 64,
            width: 64,
            name: 'blob.png',
            type: 'image',
        }
        await setInlayAsset('blob-id', asset)

        const result = await getInlayAssetBlob('blob-id')
        expect(result!.data).toBeInstanceOf(Blob)
    })

    test('migrates string data to Blob', async () => {
        const b64 = 'data:image/png;base64,aGVsbG8='
        const asset: InlayAsset = {
            data: b64,
            ext: 'png',
            height: 32,
            width: 32,
            name: 'legacy.png',
            type: 'image',
        }
        await setInlayAsset('legacy-id', asset)

        const result = await getInlayAssetBlob('legacy-id')
        expect(result!.data).toBeInstanceOf(Blob)

        // After migration, subsequent blob fetch also returns Blob
        const result2 = await getInlayAssetBlob('legacy-id')
        expect(result2!.data).toBeInstanceOf(Blob)
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

        expect(getCharacterChatIndex()).toEqual([
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

        await setInlayAsset('img-1', {
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
        nodeStorageMap.set('inlay/audio-1', new TextEncoder().encode(JSON.stringify({
            data: 'data:audio/mp3;base64,YQ==',
            ext: 'mp3',
            name: 'audio-file.mp3',
            type: 'audio',
        })))
        nodeStorageMap.set('inlay_info/audio-1', infoOnlyValue)

        const result = await listInlayExplorerItems()
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
    test.each(['txt', 'MP3', 'mp3.exe', 'no-extension'])('rejects unsupported file name %s', async (name) => {
        expect(await postInlayAsset({ name, data: new Uint8Array([0x00]) })).toBeNull()
    })

    test.each(INLAY_AUDIO_EXTENSIONS)('routes .%s files to audio storage', async (ext) => {
        const result = await postInlayAsset({ name: `sound.${ext}`, data: new Uint8Array([0x00]) })
        expect(await getInlayAssetBlob(result!)).toMatchObject({ ext, type: 'audio' })
    })

    test.each(INLAY_VIDEO_EXTENSIONS)('routes .%s files to video storage', async (ext) => {
        const result = await postInlayAsset({ name: `clip.${ext}`, data: new Uint8Array([0x00]) })
        expect(await getInlayAssetBlob(result!)).toMatchObject({ ext, type: 'video' })
    })
})

describe('fitInlayImageSize', () => {
    test('keeps dimensions inside the pixel budget unchanged', () => {
        fc.assert(fc.property(
            fc.integer({ min: 1, max: 1024 }),
            fc.integer({ min: 1, max: 1024 }),
            (width, height) => {
                expect(fitInlayImageSize(width, height)).toEqual({ width, height })
            },
        ))
    })

    test('fits large images within the budget while preserving their aspect ratio', () => {
        fc.assert(fc.property(
            fc.integer({ min: 1, max: 10_000 }),
            fc.integer({ min: 1, max: 10_000 }),
            (width, height) => {
                const fitted = fitInlayImageSize(width, height)
                expect(fitted.width * fitted.height).toBeLessThanOrEqual(INLAY_IMAGE_MAX_PIXELS)
                expect(fitted.width).toBeGreaterThan(0)
                expect(fitted.height).toBeGreaterThan(0)
                if (width * height > INLAY_IMAGE_MAX_PIXELS) {
                    expect(Math.abs(width / height - fitted.width / fitted.height) / (width / height)).toBeLessThan(0.01)
                }
            },
        ))
    })
})

describe('writeInlayImage', () => {
    test('stores image asset with correct metadata and returns id', async () => {
        const imgObj = makeImage(200, 100)

        const result = await writeInlayImage(imgObj, {
            name: 'photo.jpg',
            ext: 'jpg',
            id: 'custom-id',
        })

        expect(result).toBe('custom-id')

        const stored = await getInlayAssetBlob('custom-id')
        expect(stored).toMatchObject({
            data: expect.any(Blob),
            ext: 'webp',
            height: 100,
            name: 'photo.jpg',
            type: 'image',
            width: 200,
        })
    })

    test('stores image as lossless PNG when inlayImageLossless is true', async () => {
        getDatabaseMock.mockReturnValue({ characters: [], inlayImageLossless: true })
        const imgObj = makeImage(200, 100)

        const result = await writeInlayImage(imgObj, {
            name: 'photo.jpg',
            ext: 'jpg',
            id: 'lossless-id',
        })

        expect(result).toBe('lossless-id')

        const stored = await getInlayAssetBlob('lossless-id')
        expect(stored).toMatchObject({
            data: expect.any(Blob),
            ext: 'png',
            height: 100,
            name: 'photo.jpg',
            type: 'image',
            width: 200,
        })
    })

    test('generates uuid when no id is provided', async () => {
        const imgObj = makeImage(50, 50)

        const result = await writeInlayImage(imgObj)
        expect(result).toBe('test-uuid-1234')

        const stored = await getInlayAssetBlob('test-uuid-1234')
        expect(stored!.name).toBe('test-uuid-1234')
    })

})

describe('set -> get round-trip', () => {
    test('preserves metadata through setInlayAsset -> getInlayAsset', async () => {
        const asset: InlayAsset = {
            data: new Blob(['data'], { type: 'application/octet-stream' }),
            ext: 'custom', height: 480, width: 640, name: 'named asset', type: 'image',
        }
        await setInlayAsset('metadata-round-trip', asset)
        expect(await getInlayAsset('metadata-round-trip')).toMatchObject({
            data: expect.any(String), ext: 'custom', height: 480, width: 640,
            name: 'named asset', type: 'image',
        })
    })
})

describe('set -> remove -> get', () => {
    test('removes a stored asset from cache and persistence', async () => {
        const id = 'remove-round-trip'
        await setInlayAsset(id, {
            data: new Blob(['x']), ext: 'png', height: 1, width: 1, name: 'tmp.png', type: 'image',
        })
        expect(await getInlayAsset(id)).not.toBeNull()
        await removeInlayAsset(id)
        expect(await getInlayAsset(id)).toBeNull()
    })
})

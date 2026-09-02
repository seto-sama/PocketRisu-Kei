import { describe, expect, test, vi } from 'vitest'

vi.mock('../stores.svelte', () => ({
    DBState: { db: {} as any },
    selectedCharID: { subscribe: () => () => {} },
    selIdState: { selId: -1 },
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: () => {},
    saveAsset: async () => '',
}))

vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: null } }))
vi.mock('../alert', () => ({ notifySuccess: () => {}, alertError: () => {} }))
vi.mock('../../lang', () => ({ language: {}, changeLanguage: () => {} }))

const { setDatabase } = await import('./database.svelte')

function makeDatabase(inlayImageLossless?: boolean) {
    return {
        botPresets: [],
        formatingOrder: ['main'],
        ...(inlayImageLossless === undefined ? {} : { inlayImageLossless }),
    } as any
}

describe('inlay image settings migration', () => {
    test.each([
        [undefined, true],
        [false, true],
        [true, false],
    ])('migrates legacy lossless=%s to compression=%s', (legacy, expected) => {
        const database = makeDatabase(legacy)

        setDatabase(database)

        expect(database.inlayImageCompression).toBe(expected)
        expect(database).not.toHaveProperty('inlayImageLossless')
        expect(database).toMatchObject({
            inlayImageSize: '1k',
            inlayImageFormat: 'webp',
            inlayImageLossy: true,
            inlayImageQuality: 0.85,
        })
    })

    test('keeps an existing new compression setting over the legacy value', () => {
        const database = {
            ...makeDatabase(true),
            inlayImageCompression: true,
        }

        setDatabase(database)

        expect(database.inlayImageCompression).toBe(true)
        expect(database).not.toHaveProperty('inlayImageLossless')
    })
})

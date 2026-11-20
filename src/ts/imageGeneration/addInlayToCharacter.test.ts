import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../hash'
import type { character } from '../storage/database.svelte'
import { addChatInlaysToCharacterAssets, addGeneratedInlayToCharacter } from './addInlayToCharacter'

const mocks = vi.hoisted(() => ({
    getInlayAssetBlob: vi.fn(),
    getInlayMeta: vi.fn(),
    saveAsset: vi.fn(),
}))

vi.mock('../process/files/inlays', () => ({ getInlayAssetBlob: mocks.getInlayAssetBlob, getInlayMeta: mocks.getInlayMeta }))
vi.mock('../globalApi.svelte', () => ({ saveAsset: mocks.saveAsset }))

function createCharacter(name = 'generated-image'): character {
    return {
        type: 'character',
        image: 'assets/old.png',
        ccAssets: [],
        additionalAssets: [[name, 'assets/existing.webp', 'webp']],
    } as unknown as character
}

describe('addGeneratedInlayToCharacter', () => {
    beforeEach(() => {
        mocks.getInlayMeta.mockReset().mockResolvedValue(null)
        mocks.getInlayAssetBlob.mockReset().mockResolvedValue({
            data: new Blob(['hello'], { type: 'image/webp' }),
            ext: 'webp',
            name: 'generated-image.webp',
            type: 'image',
        })
        mocks.saveAsset.mockReset().mockResolvedValue('assets/generated.webp')
    })

    it('sets the generated image as the icon and preserves the previous icon', async () => {
        const currentCharacter = createCharacter()

        const result = await addGeneratedInlayToCharacter('{{inlay::inlay-1}}', currentCharacter, 'icon')

        expect(result.name).toBe('generated-image')
        expect(currentCharacter.image).toBe('assets/generated.webp')
        expect(currentCharacter.ccAssets).toContainEqual({
            type: 'icon',
            name: 'iconx',
            uri: 'assets/old.png',
            ext: 'png',
        })
    })

    it('uses hidden preset metadata and preserves duplicate additional asset names', async () => {
        const currentCharacter = createCharacter('Miku_smile')
        mocks.getInlayMeta.mockResolvedValue({ imageGeneration: {
            preset: { tagBundleNames: ['Miku'], sceneName: 'smile' },
        } })

        const additional = await addGeneratedInlayToCharacter(
            '{{inlayeddata::inlay-1}}', currentCharacter, 'additional',
        )

        expect(additional.name).toBe('Miku_smile')
        expect(currentCharacter.additionalAssets).toEqual([
            ['Miku_smile', 'assets/existing.webp', 'webp'],
            ['Miku_smile', 'assets/generated.webp', 'webp'],
        ])
    })

    it('rejects a message without an inlay reference', async () => {
        await expect(addGeneratedInlayToCharacter('plain text', createCharacter(), 'icon'))
            .rejects.toThrow()
        expect(mocks.saveAsset).not.toHaveBeenCalled()
    })
})

describe('addChatInlaysToCharacterAssets', () => {
    it('adds each new chat image once, skipping non-images and uploads of existing assets', async () => {
        const currentCharacter = createCharacter()
        currentCharacter.additionalAssets = [['existing', `assets/${await sha256Hex(new TextEncoder().encode('existing'))}.webp`, 'webp']]
        mocks.getInlayMeta.mockReset().mockResolvedValue(null)
        mocks.getInlayAssetBlob.mockReset().mockImplementation(async (id: string) => ({
            data: new Blob([id]),
            ext: 'webp',
            name: `${id}.webp`,
            type: id === 'video' ? 'video' : 'image',
        }))
        mocks.saveAsset.mockReset().mockImplementation(async (_bytes: Uint8Array, id: string, ext: string) =>
            `assets/${id}.${ext}`)

        const added = await addChatInlaysToCharacterAssets([
            '{{inlayed::a}} {{inlay::video}}',
            '{{inlayeddata::existing}} {{inlayed::b}}',
            '{{inlayed::a}}',
        ], currentCharacter)

        expect(added).toBe(2)
        expect(currentCharacter.additionalAssets.map(asset => asset[0])).toEqual(['existing', 'a', 'b'])
        expect(mocks.saveAsset).toHaveBeenCalledTimes(2)
    })
})

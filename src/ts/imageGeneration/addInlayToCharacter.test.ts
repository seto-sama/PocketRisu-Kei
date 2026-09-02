import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { character } from '../storage/database.svelte'
import { addGeneratedInlayToCharacter } from './addInlayToCharacter'

const mocks = vi.hoisted(() => ({
    getInlayAssetBlob: vi.fn(),
    saveAsset: vi.fn(),
}))

vi.mock('../process/files/inlays', () => ({ getInlayAssetBlob: mocks.getInlayAssetBlob }))
vi.mock('../globalApi.svelte', () => ({ saveAsset: mocks.saveAsset }))

function createCharacter(): character {
    return {
        type: 'character',
        image: 'assets/old.png',
        ccAssets: [],
        emotionImages: [['generated-image', 'assets/existing.webp']],
        additionalAssets: [['generated-image', 'assets/existing.webp', 'webp']],
    } as unknown as character
}

describe('addGeneratedInlayToCharacter', () => {
    beforeEach(() => {
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

        await addGeneratedInlayToCharacter('{{inlayed::inlay-1}}', currentCharacter, 'icon')

        expect(currentCharacter.image).toBe('assets/generated.webp')
        expect(currentCharacter.ccAssets).toContainEqual({
            type: 'icon',
            name: 'iconx',
            uri: 'assets/old.png',
            ext: 'png',
        })
    })

    it('adds emotion and additional assets with collision-free names', async () => {
        const currentCharacter = createCharacter()

        const emotion = await addGeneratedInlayToCharacter(
            '{{inlayed::inlay-1}}', currentCharacter, 'emotion',
        )
        const additional = await addGeneratedInlayToCharacter(
            '{{inlayed::inlay-1}}', currentCharacter, 'additional',
        )

        expect(emotion.name).toBe('generated-image 2')
        expect(currentCharacter.emotionImages).toContainEqual([
            'generated-image 2', 'assets/generated.webp',
        ])
        expect(additional.name).toBe('generated-image 2')
        expect(currentCharacter.additionalAssets).toContainEqual([
            'generated-image 2', 'assets/generated.webp', 'webp',
        ])
    })

    it('rejects a message without an inlay reference', async () => {
        await expect(addGeneratedInlayToCharacter('plain text', createCharacter(), 'icon'))
            .rejects.toThrow()
        expect(mocks.saveAsset).not.toHaveBeenCalled()
    })
})

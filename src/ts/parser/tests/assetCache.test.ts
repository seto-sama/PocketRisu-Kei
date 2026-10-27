import { writable } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'
import type { character, Database } from '../../storage/database.svelte'

const mocks = vi.hoisted(() => ({
    DBState: { db: { hideAllImages: false, assetMaxDifference: 0 } as Database },
    getFileSrc: vi.fn(async (path: string) => `/resolved/${path}`),
    pickHashRand: vi.fn(() => 0.99),
}))
vi.mock(import('../../storage/database.svelte'), () => ({
    pocketKeiVer: 'test', getCurrentCharacter: () => null as character, getDatabase: () => mocks.DBState.db,
}))
vi.mock(import('../../globalApi.svelte'), () => ({
    aiWatermarkingLawApplies: () => false, getFileSrc: mocks.getFileSrc,
}))
vi.mock(import('../../stores.svelte'), () => ({
    DBState: mocks.DBState, selIdState: { selId: 0 }, selectedCharID: writable(0),
}))
vi.mock(import('../../process/modules'), () => ({ getModuleAssets: () => [] }))
vi.mock(import('../../util'), async (importOriginal) => ({ ...await importOriginal(), pickHashRand: mocks.pickHashRand }))
vi.mock(import('../../process/scripts'), () => ({
    processScriptFull: async (_char: unknown, data: string) => ({ data }),
}))

import { prepareMarkdownSource, resetAssetsCache, type simpleCharacterArgument } from '../parser.svelte'

function makeCharacter(id: string): simpleCharacterArgument {
    return {
        type: 'simple', chaId: id, name: id, customscript: [],
        additionalAssets: [['shared', `${id}.png`, 'png']],
        emotionImages: [['happy', `${id}-happy.png`]],
    }
}

describe('character asset cache ownership', () => {
    it('isolates concurrent full and simple character renders with identical asset names', async () => {
        const a = { ...makeCharacter('a'), type: 'character' } as unknown as character
        const b = makeCharacter('b')
        const source = '{{raw::shared}} {{emotion::happy}}'
        const [first, second] = await Promise.all([
            prepareMarkdownSource(source, a), prepareMarkdownSource(source, b),
        ])
        expect(first).toContain('/resolved/a.png')
        expect(first).toContain('/resolved/a-happy.png')
        expect(second).toContain('/resolved/b.png')
        expect(second).toContain('/resolved/b-happy.png')
        expect(await prepareMarkdownSource(source, a)).toBe(first)
    })

    it('keeps cache invalidation for edited assets and does not leak assets into an empty character', async () => {
        const a = makeCharacter('edited')
        await prepareMarkdownSource('{{raw::shared}}', a)
        a.additionalAssets = [['shared', 'replacement.png', 'png']]
        resetAssetsCache(a.additionalAssets, a.emotionImages, [], a.chaId)
        expect(await prepareMarkdownSource('{{raw::shared}}', a)).toBe('/resolved/replacement.png')
        expect(await prepareMarkdownSource('{{raw::shared}}', { type: 'simple', chaId: 'empty', name: 'empty', customscript: [] })).toBe('')
    })

    it('picks same-name image variants even when their extensions differ', async () => {
        const char: simpleCharacterArgument = {
            type: 'simple', chaId: 'variants', name: 'variants', customscript: [],
            additionalAssets: [['happy', 'happy.png', 'png'], ['happy', 'happy-2.webp', 'webp']],
        }
        expect(await prepareMarkdownSource('{{raw::happy}}', char)).toBe('/resolved/happy-2.webp')
    })

    it('draws asset-prompt image tags only for assets that exist', async () => {
        const char = {
            type: 'character', chaId: 'asset-prompt', name: 'asset-prompt', customscript: [],
            prebuiltAssetCommand: true, additionalAssets: [['Ares_angry', 'ares-angry.png', 'png']],
        } as unknown as character
        const html = await prepareMarkdownSource('<assets src="Ares angry">\n\n<assets src="Ares sad"></assets>', char)
        const document = new DOMParser().parseFromString(html, 'text/html')
        expect(Array.from(document.querySelectorAll('img'), image => image.getAttribute('src'))).toEqual(['/resolved/ares-angry.png'])
        expect(document.querySelector('assets')).toBeNull()
    })

    it.each([
        ['Ares_angry.svg', ' ares-angry.svg ', 'svg', true],
        ['A.res_angry.png', 'Ares angry', 'png', false],
    ])('matches asset-prompt name %s against %s exactly after normalization', async (name, requested, ext, matches) => {
        const char = {
            type: 'character', chaId: name, name, customscript: [],
            prebuiltAssetCommand: true, additionalAssets: [[name, `asset.${ext}`, ext]],
        } as unknown as character
        const html = await prepareMarkdownSource(`<assets src="${requested}">`, char)
        const image = new DOMParser().parseFromString(html, 'text/html').querySelector('img')
        expect(image?.getAttribute('src') ?? null).toBe(matches ? `/resolved/asset.${ext}` : null)
    })
})

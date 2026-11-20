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

import { prepareMarkdownSource, resetAssetsCache, resolveBareAssetSrc, type simpleCharacterArgument } from '../parser.svelte'

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
        // Chat messages render with the simple character argument.
        const char: simpleCharacterArgument = {
            type: 'simple', chaId: 'asset-prompt', name: 'asset-prompt', customscript: [],
            additionalAssets: [['Miku_angry', 'miku-angry.png', 'png']],
        }
        const html = await prepareMarkdownSource('<assets src="Miku angry">\n\n<assets src="Miku sad"></assets>', char)
        const document = new DOMParser().parseFromString(html, 'text/html')
        expect(Array.from(document.querySelectorAll('img'), image => image.getAttribute('src'))).toEqual(['/resolved/miku-angry.png'])
        expect(document.querySelector('assets')).toBeNull()
    })

    it.each([
        ['Miku_angry.svg', ' miku-angry.svg ', 'svg', true],
        ['Mi.ku_angry.png', 'Miku angry', 'png', false],
        ['하츠네 미쿠（평상복）_bored'.normalize('NFD'), '하츠네 미쿠 (평상복) bored', 'png', true],
    ])('matches asset-prompt name %s against %s exactly after normalization', async (name, requested, ext, matches) => {
        const char = {
            type: 'character', chaId: name, name, customscript: [],
            prebuiltAssetCommand: true, additionalAssets: [[name, `asset.${ext}`, ext]],
        } as unknown as character
        const html = await prepareMarkdownSource(`<assets src="${requested}">`, char)
        const image = new DOMParser().parseFromString(html, 'text/html').querySelector('img')
        expect(image?.getAttribute('src') ?? null).toBe(matches ? `/resolved/asset.${ext}` : null)
    })

    it('resolves bare <img src> asset names without falling back to an unrelated asset', async () => {
        const char: simpleCharacterArgument = {
            type: 'simple', chaId: 'bare-src', name: 'bare-src', customscript: [],
            additionalAssets: [['Hatsune Miku_bored', 'bored.png', 'png']],
        }
        expect(await resolveBareAssetSrc('hatsune miku bored.png', char)).toBe('/resolved/bored.png')
        expect(await resolveBareAssetSrc('unknown', char)).toBeNull()
    })
})

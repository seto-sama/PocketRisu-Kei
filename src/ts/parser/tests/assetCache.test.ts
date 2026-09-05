import { writable } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'
import type { character, Database } from '../../storage/database.svelte'

const mocks = vi.hoisted(() => ({
    DBState: { db: { hideAllImages: false, legacyMediaFindings: true } as Database },
    getFileSrc: vi.fn(async (path: string) => `/resolved/${path}`),
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
vi.mock(import('../../process/scripts'), () => ({
    processScriptFull: async (_char: unknown, data: string) => ({ data }),
}))

import { prepareMarkdownSource, resetAssetsCache, type simpleCharacterArgument } from '../parser.svelte'

function makeCharacter(id: string): simpleCharacterArgument {
    return {
        type: 'simple', chaId: id, name: id,
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
        expect(await prepareMarkdownSource('{{raw::shared}}', { type: 'simple', chaId: 'empty', name: 'empty' })).toBe('')
    })
})

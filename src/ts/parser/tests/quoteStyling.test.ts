import { writable } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database, character } from '../../storage/database.svelte'

const storeMocks = vi.hoisted(() => ({
    DBState: {
        db: {
            blockquoteStyling: true,
            cornerBracketStyling: false,
            customQuotes: false,
            unformatQuotes: false,
        } as Database,
    },
}))

vi.mock(import('../../storage/database.svelte'), () => ({
    appVer: 'test',
    getCurrentCharacter: () => null as unknown as character,
    getDatabase: () => storeMocks.DBState.db,
}))

vi.mock(import('../../globalApi.svelte'), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(''),
}))

vi.mock(import('../../stores.svelte'), () => ({
    DBState: storeMocks.DBState,
    selIdState: { selId: 0 },
    selectedCharID: writable(0),
}))

import { renderPreparedMarkdown } from '../parser.svelte'

describe('quote styling', () => {
    beforeEach(() => {
        storeMocks.DBState.db.blockquoteStyling = true
        storeMocks.DBState.db.cornerBracketStyling = false
        storeMocks.DBState.db.customQuotes = false
        storeMocks.DBState.db.unformatQuotes = false
    })

    it.each([
        '설명(뭐시기)',
        '설명[뭐시기]',
        '설명{뭐시기}',
        '설명（뭐시기）',
    ])('keeps a bracket-ending quote inline: %s', async (content) => {
        const rendered = await renderPreparedMarkdown(`"${content}"`, 'notrim')

        expect(rendered).toContain('risu-mark="quote2"')
        expect(rendered).not.toContain('risu-mark="blockquote2"')
    })

    it('keeps sentence-ending punctuation styled as dialogue', async () => {
        const rendered = await renderPreparedMarkdown('"설명입니다."', 'notrim')

        expect(rendered).toContain('risu-mark="blockquote2"')
    })
})

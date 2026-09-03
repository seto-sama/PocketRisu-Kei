import { writable } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database, character } from '../../storage/database.svelte'

const storeMocks = vi.hoisted(() => ({
    DBState: {
        db: {
            characters: [{ chatPage: 0, chats: [{}], defaultVariables: '' }],
            globalChatVariables: {},
            hideAllImages: false,
            returnCSSError: false,
            templateDefaultVariables: '',
        } as unknown as Database,
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

import { prepareMarkdownSource, renderPreparedMarkdown, trimMarkdown } from '../parser.svelte'

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html').body

describe('trimMarkdown custom styles', () => {
    beforeEach(() => {
        storeMocks.DBState.db.hideAllImages = false
        storeMocks.DBState.db.returnCSSError = false
    })

    it.each([
        {
            css: '.bg { background-image: url("data:image/svg+xml,<svg><circle r=\'4\'/></svg>"); }',
            expected: 'data:image/svg+xml,<svg>',
        },
        {
            css: 'p::after { content: "<label>"; }',
            expected: 'content:"<label>"',
        },
    ])('keeps scoped CSS containing markup-like text: $css', async ({ css, expected }) => {
        const prepared = await prepareMarkdownSource(`<style>${css}</style><p class="bg">text</p>`, null, 'back')
        const output = await renderPreparedMarkdown(prepared, 'back')

        expect(prepared).toContain('<risu-style>')
        expect(output).toContain('<style>')
        expect(output).toContain('.chattext ')
        expect(output).toContain(expected)
    })

    it('keeps the no-style path sanitized without constructing style output', () => {
        const output = trimMarkdown('<div onmouseover="alert(1)">safe</div>')

        expect(output).toContain('safe')
        expect(output).not.toContain('onmouseover')
        expect(output).not.toContain('<style')
    })

    it('keeps decoded closing-tag text inert inside the style element', () => {
        const css = '.safe{content:"</style><img src=x onerror=alert(1)>";}'
        const hex = Buffer.from(css).toString('hex')
        const body = parse(trimMarkdown(`<risu-style>${hex}</risu-style>`))

        expect(body.querySelectorAll('style')).toHaveLength(1)
        expect(body.querySelector('img')).toBeNull()
    })

    it('does not decode a style token embedded in an attribute', () => {
        const hex = Buffer.from('body{display:none}').toString('hex')
        const body = parse(trimMarkdown(`<div title='<risu-style>${hex}</risu-style>'>safe</div>`))

        expect(body.querySelector('style')).toBeNull()
        expect(body.textContent).toContain('safe')
    })

    it('uses one text-only fallback path for CSS errors and caches it per setting', () => {
        const hex = Buffer.from('<img src=x onerror=alert(1)>').toString('hex')
        const input = `<risu-style>${hex}</risu-style>`

        expect(trimMarkdown(input)).toBe('')

        storeMocks.DBState.db.returnCSSError = true
        const body = parse(trimMarkdown(input))
        expect(body.textContent).toContain('CSS ERROR:')
        expect(body.querySelector('img')).toBeNull()
    })
})

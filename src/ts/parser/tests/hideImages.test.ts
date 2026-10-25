import { describe, it, expect, vi, beforeEach } from 'vitest'
import { writable } from 'svelte/store'
import type { character, Database } from '../../storage/database.svelte'

//#region module mocks

const mocks = vi.hoisted(() => ({
    DBState: {
        db: {
            hideAllImages: true,
            assetMaxDifference: 0,
            characters: [{ chatPage: 0, chats: [{}], defaultVariables: '' }],
            globalChatVariables: {},
            templateDefaultVariables: '',
        } as unknown as Database,
    },
}))

vi.mock(import('../../storage/database.svelte'), () => ({
    pocketKeiVer: 'test',
    getCurrentCharacter: () => null as unknown as character,
    getDatabase: () => mocks.DBState.db,
}))

vi.mock(import('../../globalApi.svelte'), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: async (path: string) => `/resolved/${path}`,
}))

vi.mock(import('../../stores.svelte'), () => ({
    DBState: mocks.DBState,
    selIdState: { selId: 0 },
    selectedCharID: writable(0),
}))

vi.mock(import('../../process/modules'), () => ({ getModuleAssets: () => [] }))
vi.mock(import('../../process/scripts'), () => ({
    processScriptFull: async (_char: unknown, data: string) => ({ data, emoChanged: false }),
}))

//#endregion

import { HIDE_ALL_IMAGES_LINK_ATTRIBUTE, IMAGE_NOTICE_ATTRIBUTE, parseOnboardingHTML, prepareMarkdownSource, renderPreparedMarkdown, trimMarkdown, type simpleCharacterArgument } from '../parser.svelte'
import { hiddenImageSrc, hideCssImageUrls, hideStyleSheetImages, renderHiddenImageSvg } from '../hideImages'

beforeEach(() => {
    mocks.DBState.db.hideAllImages = true
    mocks.DBState.db.colorScheme = undefined
})

const noticeChar: simpleCharacterArgument = {
    type: 'simple', chaId: 'notice', name: 'notice', customscript: [],
    additionalAssets: [['shared', 'shared.png', 'png']],
}
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html').body
const placeholderUrl = `url("${hiddenImageSrc}")`
const leaked = 'https://example.com/leak.png'

describe('hideCssImageUrls', () => {
    it('replaces whole url() calls, quoted parentheses included', () => {
        expect(hideCssImageUrls(`background-image:linear-gradient(red, blue), url('a(1).png')`)).toBe(`background-image:linear-gradient(red, blue), ${placeholderUrl}`)
    })

    it('replaces image-set as a whole', () => {
        expect(hideCssImageUrls(`background-image:-webkit-image-set("a.png" 1x, url(b.png) 2x)`)).toBe(`background-image:${placeholderUrl}`)
    })

    it('keeps fragment references', () => {
        expect(hideCssImageUrls('fill:url(#grad)')).toBe('fill:url(#grad)')
    })
})

describe('hideStyleSheetImages', () => {
    it('leaves fonts and cursors alone', () => {
        const out = hideStyleSheetImages(`@font-face{font-family:x;src:url(x.woff2)}.a{cursor:url(c.png),auto;background:url(${leaked})}`)
        expect(out).toContain('url(x.woff2)')
        expect(out).toContain('url(c.png)')
        expect(out).not.toContain(leaked)
    })

    it('reaches into nested at-rules and keyframes', () => {
        const out = hideStyleSheetImages(`@media (min-width:1px){.a{background:url(${leaked})}}@keyframes k{from{background:url(${leaked})}}`)
        expect(out).not.toContain(leaked)
    })
})

describe('sanitized markup', () => {
    it('swaps image sources on elements and inline styles', () => {
        const body = parse(trimMarkdown(`<img src="${leaked}" srcset="${leaked} 2x" alt="x"><div style="color:red;background:url(${leaked})"></div>`))
        const img = body.querySelector('img')
        expect(img.getAttribute('src')).toBe(hiddenImageSrc)
        expect(img.hasAttribute('srcset')).toBe(false)
        expect(body.querySelector('div').getAttribute('style')).toContain('color:red')
        expect(body.innerHTML).not.toContain(leaked)
    })
})

describe('hidden image theming', () => {
    it('themes every placeholder in cached output with the scheme current at render time', () => {
        const html = `<img src="${hiddenImageSrc}"><div style="background:url(&quot;${hiddenImageSrc}&quot;)"></div><style>.a{background:url("${hiddenImageSrc}")}</style>`
        for (const darkbg of ['#111111', '#222222']) {
            mocks.DBState.db.colorScheme = { darkbg } as Database['colorScheme']
            const out = trimMarkdown(html)
            expect(out).not.toContain(hiddenImageSrc)
            expect(decodeURIComponent(out).split(darkbg)).toHaveLength(4)
        }
    })

    it('falls back on values that are not plain colors', () => {
        const svg = renderHiddenImageSvg({ darkbg: '"/><script>alert(1)</script>' })
        expect(svg).not.toContain('script')
    })
})

describe('image notices', () => {
    const char = noticeChar
    const render = async (input: string, mode: 'normal' | 'back') =>
        parse(await renderPreparedMarkdown(await prepareMarkdownSource(input, char, mode), mode))

    it('names a missing img asset in chat, intact through markdown', async () => {
        mocks.DBState.db.hideAllImages = false
        const body = await render('see {{img::gone_*1*}} here', 'normal')
        const notice = body.querySelector(`[${IMAGE_NOTICE_ATTRIBUTE}="missingImage"]`)
        expect(notice?.textContent).toContain('gone_*1*')
    })

    it('keeps backgrounds free of notices', async () => {
        mocks.DBState.db.hideAllImages = false
        expect(await prepareMarkdownSource('{{img::gone}}', char, 'back')).toBe('')
        mocks.DBState.db.hideAllImages = true
        expect(await prepareMarkdownSource('{{img::shared}}{{raw::shared}}', char, 'back')).toBe('')
    })

    it('links hidden chat assets to the Hide All Images setting', async () => {
        const body = await render('{{image::shared}}', 'normal')
        const notice = body.querySelector(`[${IMAGE_NOTICE_ATTRIBUTE}="hidden"]`)
        expect(notice?.querySelector(`button[${HIDE_ALL_IMAGES_LINK_ATTRIBUTE}]`)).not.toBeNull()
        expect(body.innerHTML).not.toContain('/resolved/shared.png')
    })

    it('leaves onboarding images visible', async () => {
        const html = await parseOnboardingHTML(
            '{{img::shared}}<img src="https://example.com/a.png"><div style="background:url(b.png)"></div>',
            char as unknown as character,
        )
        expect(html).toContain('/resolved/shared.png')
        expect(html).toContain('https://example.com/a.png')
        expect(html).toContain('url(b.png)')
        expect(html).not.toContain(hiddenImageSrc)
    })
})

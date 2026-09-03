import { writable } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database, character } from '../../storage/database.svelte'

const storeMocks = vi.hoisted(() => ({
    DBState: {
        db: {
            hideAllImages: false,
            preloadChatImages: true,
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

import { parseInlayAssets, preloadInlayAssets, preloadInlayAssetsWhenNear, preloadRenderedChatImages, resolveInlayPlaceholders } from '../parser.svelte'

describe('inlay parsing', () => {
    afterEach(() => {
        storeMocks.DBState.db.hideAllImages = false
        storeMocks.DBState.db.preloadChatImages = false
        void preloadRenderedChatImages('')
        storeMocks.DBState.db.preloadChatImages = true
        vi.unstubAllGlobals()
    })

    it.each(['inlay', 'inlayed', 'inlayeddata'])('renders %s with the styled wrapper', (token) => {
        const rendered = parseInlayAssets(`{{${token}::asset-id}}`)

        expect(rendered).toContain('<div class="risu-inlay-image" data-inlay-viewer-id="asset-id">')
        expect(rendered).toContain('data-inlay-id="asset-id"')
        expect(rendered).not.toContain('data-inlay-type')
    })

    it('warms only the requested number of nearby assets without mounting DOM', async () => {
        const requestedUrls: string[] = []
        vi.stubGlobal('Image', class {
            onload: (() => void) | null = null
            onerror: (() => void) | null = null

            set src(value: string) {
                requestedUrls.push(value)
                queueMicrotask(() => this.onload?.())
            }

            removeAttribute() {}
        })

        await preloadInlayAssets([
            '{{inlayed::near-1}}',
            '{{inlayed::near-2}}',
            '{{inlayed::far-3}}',
        ], 2)

        expect(requestedUrls).toHaveLength(2)
    })

    it('warms resolved image assets, including raw assets used in img src', async () => {
        const requestedUrls: string[] = []
        vi.stubGlobal('Image', class {
            onload: (() => void) | null = null
            onerror: (() => void) | null = null

            set src(value: string) {
                requestedUrls.push(value)
                queueMicrotask(() => this.onload?.())
            }

            removeAttribute() {}
        })

        await preloadRenderedChatImages(`
            <img src="resolved-raw-asset.webp">
            <div style="background-image: url('resolved-background.png')"></div>
            <video poster="resolved-poster.jpg"></video>
        `)

        expect(requestedUrls).toEqual([
            'resolved-raw-asset.webp',
            'resolved-poster.jpg',
            'resolved-background.png',
        ])
    })

    it('keeps ten recent images across DOM cleanup and serializes explicit decodes', async () => {
        const requestedUrls: string[] = []
        let removedSources = 0
        let activeDecodes = 0
        let maxActiveDecodes = 0
        let completedDecodes = 0
        vi.stubGlobal('Image', class {
            onload: (() => void) | null = null
            onerror: (() => void) | null = null

            set src(value: string) {
                requestedUrls.push(value)
                queueMicrotask(() => this.onload?.())
            }

            removeAttribute(name: string) {
                if (name === 'src') removedSources += 1
            }

            async decode() {
                activeDecodes += 1
                maxActiveDecodes = Math.max(maxActiveDecodes, activeDecodes)
                await new Promise<void>(resolve => queueMicrotask(resolve))
                activeDecodes -= 1
                completedDecodes += 1
            }
        })
        vi.stubGlobal('IntersectionObserver', class {
            constructor() {
                throw new Error('a visible new message should retain swipes immediately')
            }
        })
        const chatRoot = {
            clientHeight: 800,
            getBoundingClientRect: () => ({ top: 0, bottom: 800 }),
        }
        const messageRoot = {
            closest: () => chatRoot,
            getBoundingClientRect: () => ({ top: 700, bottom: 760 }),
        } as unknown as HTMLElement

        const cleanup = preloadInlayAssetsWhenNear(messageRoot, [
            '{{inlayed::retained-1}}',
            '{{inlayed::retained-2}}',
            '{{inlayed::retained-3}}',
            '{{inlayed::retained-4}}',
            '{{inlayed::retained-5}}',
            '{{inlayed::retained-6}}',
            '{{inlayed::retained-7}}',
            '{{inlayed::retained-8}}',
            '{{inlayed::retained-9}}',
            '{{inlayed::retained-10}}',
            '{{inlayed::retained-11}}',
        ])
        await vi.waitFor(() => expect(completedDecodes).toBe(11))

        expect(requestedUrls).toHaveLength(11)
        expect(maxActiveDecodes).toBe(1)
        expect(removedSources).toBeGreaterThanOrEqual(1)
        cleanup()

        const cleanupAfterReturn = preloadInlayAssetsWhenNear(messageRoot, [
            '{{inlayed::retained-11}}',
        ])
        await Promise.resolve()
        expect(requestedUrls).toHaveLength(11)
        cleanupAfterReturn()
    })

    it('replaces a failed directly cached inlay image with the missing-asset UI', async () => {
        vi.stubGlobal('Image', class {
            onload: (() => void) | null = null
            onerror: (() => void) | null = null

            set src(_value: string) {
                queueMicrotask(() => this.onload?.())
            }
        })
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
            headers: { 'content-type': 'text/plain' },
            status: 404,
        })))
        await preloadInlayAssets('{{inlayed::missing-cached-inlay}}')

        const root = document.createElement('div')
        root.innerHTML = parseInlayAssets('{{inlayed::missing-cached-inlay}}')
        const cleanup = resolveInlayPlaceholders(root)
        root.querySelector('img')?.dispatchEvent(new Event('error'))

        await vi.waitFor(() => {
            expect(root.querySelector('[data-missing-inlay-id="missing-cached-inlay"]')).not.toBeNull()
        })
        cleanup()
    })

    it.each([
        { hideAllImages: false, preloadChatImages: false },
        { hideAllImages: true, preloadChatImages: true },
    ])('does not warm images when preloading is unavailable: %o', async (settings) => {
        const requestedUrls: string[] = []
        storeMocks.DBState.db.hideAllImages = settings.hideAllImages
        storeMocks.DBState.db.preloadChatImages = settings.preloadChatImages
        vi.stubGlobal('Image', class {
            set src(value: string) {
                requestedUrls.push(value)
            }
        })

        await Promise.all([
            preloadInlayAssets('{{inlayed::disabled-inlay}}'),
            preloadRenderedChatImages('<img src="disabled-asset.webp">'),
        ])

        expect(requestedUrls).toEqual([])
    })
})

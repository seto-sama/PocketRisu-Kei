import { afterEach, describe, expect, it, vi } from 'vitest'

describe('Tailwind breakpoint stores', () => {
    afterEach(() => {
        document.documentElement.style.removeProperty('--breakpoint-md')
        document.documentElement.style.removeProperty('--breakpoint-lg')
        vi.unstubAllGlobals()
        vi.resetModules()
    })

    it('builds media queries from Tailwind theme variables', async () => {
        document.documentElement.style.setProperty('--breakpoint-md', '48rem')
        document.documentElement.style.setProperty('--breakpoint-lg', '64rem')

        const matchMedia = vi.fn((query: string) => ({
            matches: query.includes('48rem'),
            media: query,
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList)
        vi.stubGlobal('matchMedia', matchMedia)

        const { lgViewport, mdViewport } = await import('./breakpoints')

        expect(mdViewport.matches()).toBe(true)
        expect(lgViewport.matches()).toBe(false)
        expect(matchMedia).toHaveBeenCalledWith('(min-width: 48rem)')
        expect(matchMedia).toHaveBeenCalledWith('(min-width: 64rem)')
        expect(matchMedia).toHaveBeenCalledTimes(2)

        const media = matchMedia.mock.results[0].value
        const unsubscribeFirst = mdViewport.subscribe(() => {})
        const unsubscribeSecond = mdViewport.subscribe(() => {})
        expect(media.addEventListener).toHaveBeenCalledTimes(1)
        unsubscribeFirst()
        expect(media.removeEventListener).not.toHaveBeenCalled()
        unsubscribeSecond()
        expect(media.removeEventListener).toHaveBeenCalledWith('change', vi.mocked(media.addEventListener).mock.calls[0][1])
    })
})

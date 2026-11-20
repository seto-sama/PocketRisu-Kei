import { afterEach, describe, expect, it, vi } from 'vitest'

describe('Tailwind breakpoint queries', () => {
    afterEach(() => {
        document.documentElement.style.removeProperty('--breakpoint-md')
        document.documentElement.style.removeProperty('--breakpoint-lg')
        vi.unstubAllGlobals()
        vi.resetModules()
    })

    function stubMatchMedia() {
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
        return matchMedia
    }

    it('builds media queries from Tailwind theme variables', async () => {
        document.documentElement.style.setProperty('--breakpoint-md', '48rem')
        document.documentElement.style.setProperty('--breakpoint-lg', '64rem')
        const matchMedia = stubMatchMedia()

        const { lgViewport, mdViewport } = await import('./breakpoints')

        expect(mdViewport.current).toBe(true)
        expect(lgViewport.current).toBe(false)
        expect(matchMedia).toHaveBeenCalledWith('(min-width: 48rem)')
        expect(matchMedia).toHaveBeenCalledWith('(min-width: 64rem)')
    })
})

import { readable, type Readable } from 'svelte/store'

type TailwindBreakpoint = 'md' | 'lg'
const mediaQueries = new Map<TailwindBreakpoint, MediaQueryList>()

export type BreakpointStore = Readable<boolean> & {
    matches: () => boolean
}

function getMediaQuery(breakpoint: TailwindBreakpoint): MediaQueryList | null {
    const cached = mediaQueries.get(breakpoint)
    if (cached) return cached

    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(`--breakpoint-${breakpoint}`)
        .trim()

    if (!value) return null

    const mediaQuery = window.matchMedia(`(min-width: ${value})`)
    mediaQueries.set(breakpoint, mediaQuery)
    return mediaQuery
}

function createBreakpointStore(breakpoint: TailwindBreakpoint): BreakpointStore {
    const matches = () => getMediaQuery(breakpoint)?.matches ?? false
    const store = readable(matches(), (set) => {
        const mediaQuery = getMediaQuery(breakpoint)
        if (!mediaQuery) return

        const update = () => set(mediaQuery.matches)
        update()
        mediaQuery.addEventListener('change', update)
        return () => mediaQuery.removeEventListener('change', update)
    })

    return { subscribe: store.subscribe, matches }
}

// Tailwind v4 emits these values from its theme as CSS custom properties.
// Reading them here keeps JavaScript behavior tied to the CSS source of truth.
export const mdViewport = createBreakpointStore('md')
export const lgViewport = createBreakpointStore('lg')

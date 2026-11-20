import { MediaQuery } from 'svelte/reactivity'

type TailwindBreakpoint = 'md' | 'lg'

// Tailwind v4 emits these values from its theme as CSS custom properties.
// Reading them here keeps JavaScript behavior tied to the CSS source of truth;
// index.html loads the stylesheet before the app script, so they are resolved.
function breakpointQuery(breakpoint: TailwindBreakpoint) {
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(`--breakpoint-${breakpoint}`)
        .trim()
    return new MediaQuery(`min-width: ${value}`)
}

export const mdViewport = breakpointQuery('md')
export const lgViewport = breakpointQuery('lg')

export const isTouchDevice = new MediaQuery('pointer: coarse')

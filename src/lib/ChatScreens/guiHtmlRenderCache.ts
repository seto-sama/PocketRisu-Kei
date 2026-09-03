const MAX_ENTRIES = 32
const MAX_SOURCE_CHARACTERS = 512_000

const cache = new Map<string, HTMLElement>()
let cachedSourceCharacters = 0

/**
 * Cache only the fully expanded HTML. CBS output can depend on the active
 * character, persona, role, and variables, so caching by the preset source
 * alone could return stale markup. The expanded string is a complete and safe
 * cache key while still allowing identical role variants to share DOMParser
 * work across messages.
 */
export function getParsedGuiHtml(expandedHtml: string): HTMLElement {
    const cached = cache.get(expandedHtml)
    if (cached) {
        cache.delete(expandedHtml)
        cache.set(expandedHtml, cached)
        return cached
    }

    const body = new DOMParser().parseFromString(expandedHtml, 'text/html').body
    cache.set(expandedHtml, body)
    cachedSourceCharacters += expandedHtml.length

    while (cache.size > MAX_ENTRIES || cachedSourceCharacters > MAX_SOURCE_CHARACTERS) {
        const oldestSource = cache.keys().next().value
        if (oldestSource === undefined) break
        cache.delete(oldestSource)
        cachedSourceCharacters -= oldestSource.length
    }

    return body
}

export function clearGuiHtmlRenderCache(): void {
    cache.clear()
    cachedSourceCharacters = 0
}

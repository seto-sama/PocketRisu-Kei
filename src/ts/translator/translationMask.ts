// translate="no" elements become placeholders so their per-generation IDs stay
// out of the LLM cache key. Tags are scanned in the string because
// re-serializing a DOM would rewrite raw message text.

const notranslateHint = /\stranslate\s*=\s*["']?no\b/i
const notranslateAttribute = /(?:^|\s)translate\s*=\s*(["']?)no\1(?=[\s/]|$)/i
const tagPattern = /<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g
const voidElements = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
])
const placeholderSource = String.raw`<x-notrans\s+n\s*=\s*["']?(\d+)["']?\s*(?:\/>|>\s*<\/x-notrans\s*>)`
const placeholderPattern = new RegExp(placeholderSource, 'gi')
const placeholderProbe = new RegExp(placeholderSource, 'i')

export interface MaskedTranslationSource {
    source: string
    restore: (translated: string) => string
}

// A translation carried over from a source that still had masked elements
// keeps their placeholders; with nothing to restore they are dropped.
const unmasked = (source: string): MaskedTranslationSource => ({
    source,
    restore: stripTranslationPlaceholders,
})

function findElementEnd(source: string, tagName: string, from: number): number | null {
    const lowerName = tagName.toLowerCase()
    const tags = new RegExp(tagPattern.source, 'g')
    tags.lastIndex = from
    let depth = 1
    for (let match = tags.exec(source); match; match = tags.exec(source)) {
        if (match[2].toLowerCase() !== lowerName) continue
        if (match[1]) {
            depth -= 1
            if (depth === 0) return tags.lastIndex
        }
        else if (!/\/\s*$/.test(match[3])) {
            depth += 1
        }
    }
    return null
}

export function maskUntranslatable(source: string): MaskedTranslationSource {
    // Messages without the marker keep their exact pre-existing cache key.
    if (!notranslateHint.test(source)) return unmasked(source)

    const segments: string[] = []
    let masked = ''
    let copiedUntil = 0
    const tags = new RegExp(tagPattern.source, 'g')
    for (let match = tags.exec(source); match; match = tags.exec(source)) {
        const [openTag, closing, tagName, attributes] = match
        if (closing || !notranslateAttribute.test(attributes)) continue
        const selfContained = /\/\s*$/.test(attributes) || voidElements.has(tagName.toLowerCase())
        const end = selfContained ? tags.lastIndex : findElementEnd(source, tagName, tags.lastIndex)
        // An unclosed element stays translatable rather than swallowing the rest.
        if (end === null) continue
        masked += source.slice(copiedUntil, match.index) + `<x-notrans n="${segments.length}"></x-notrans>`
        segments.push(source.slice(match.index, end))
        copiedUntil = end
        tags.lastIndex = Math.max(end, match.index + openTag.length)
    }
    if (segments.length === 0) return unmasked(source)
    masked += source.slice(copiedUntil)

    return {
        source: masked,
        restore(translated) {
            const used = new Set<number>()
            let restored = translated.replace(placeholderPattern, (_match, index: string) => {
                const segmentIndex = Number(index)
                if (segmentIndex >= segments.length || used.has(segmentIndex)) return ''
                used.add(segmentIndex)
                return segments[segmentIndex]
            })
            // A placeholder the translator dropped must not lose its element.
            const missing = segments.filter((_segment, segmentIndex) => !used.has(segmentIndex))
            if (missing.length > 0) {
                restored += '\n\n' + missing.join('\n\n')
            }
            return restored
        },
    }
}

export function stripTranslationPlaceholders(source: string) {
    return source.replace(placeholderPattern, '')
}

export function hasTranslationPlaceholders(source: string) {
    return placeholderProbe.test(source)
}

export function getTranslationSourceKey(source: string) {
    return maskUntranslatable(source).source
}

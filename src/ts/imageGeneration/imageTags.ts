// Tag names and Korean descriptions: https://huggingface.co/datasets/mengod-hf/danbooru-tags-kr
// Download metadata and license links are in server/imageTags.cjs.
import type { CompletionSource } from '@codemirror/autocomplete'
import { language } from 'src/lang'
import { forageStorage } from '../storage/autoStorage'
import { INPUT_COMMIT_DEBOUNCE_MS } from '../inputCommit'
import type { CompletionContent } from '../gui/completionContent'
import { isImageTagBundleQuery, searchImageTagBundles, type ImageTagBundle } from './tagBundles'

const imageTagCategories = [
    [0, 'general'], [1, 'artist'], [3, 'copyright'], [4, 'character'], [5, 'meta'],
] as const

interface ImageTag {
    name: string
    category: number
    count: number
    description: string
}

export type ImageTagStatus = 'idle' | 'loading' | 'error'
type SearchTags = (query: string, signal: AbortSignal) => Promise<ImageTag[]>

interface ImagePromptSearchOptions {
    search?: SearchTags
    getBundles?: () => ImageTagBundle[]
}

const numericWeight = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)'
const weightPrefix = new RegExp(`^${numericWeight}::\\s*`)
const weightSuffix = new RegExp(`:\\s*${numericWeight}\\s*$`)
const weightNumbers = new RegExp(`${numericWeight}(?=::)|(?<=:)\\s*${numericWeight}(?=\\s*[\\])}]|$)`, 'g')

export function getImageTagRange(text: string, cursor: number) {
    const weightPeriods = new Set<number>()
    for (const match of text.matchAll(weightNumbers)) {
        for (let index = 0; index < match[0].length; index += 1) {
            if (match[0][index] === '.') weightPeriods.add(match.index! + index)
        }
    }
    const isSeparator = (index: number) => /[,|\n\r]/.test(text[index])
        || (text[index] === '.' && !weightPeriods.has(index))
    let from = cursor
    let to = cursor
    while (from > 0 && !isSeparator(from - 1)) from -= 1
    while (to < text.length && !isSeparator(to)) to += 1
    let segment = text.slice(from, to)
    from += segment.length - segment.trimStart().length
    to -= segment.length - segment.trimEnd().length
    const segmentEnd = to
    segment = text.slice(from, to)
    const weight = segment.match(weightPrefix)?.[0]
    if (weight) {
        from += weight.length
        if (text.slice(from, to).endsWith('::')) to -= 2
    }
    const opening = text.slice(from, to).match(/^[{\[(]+\s*/)?.[0] ?? ''
    from += opening.length
    const wrappers = opening.trim().length
    for (let index = 0; index < wrappers && /[}\])]$/.test(text.slice(from, to)); index += 1) to -= 1
    if (wrappers) to -= text.slice(from, to).match(weightSuffix)?.[0].length ?? 0
    // Leave CBS expressions to their source, allowing weighted bundle references.
    if ((segment.includes('{{') || segment.includes('}}')) && !isImageTagBundleQuery(text.slice(from, to))) return null
    from += text.slice(from, to).match(/^(?:artist:|@)\s*/)?.[0].length ?? 0
    while (to > from && /\s/.test(text[to - 1])) to -= 1
    if (cursor < from || (cursor > to && text.slice(to, cursor).trim())) return null
    const query = text.slice(from, cursor).trim()
    if (!query || query.length > 200) return null
    // Preserve closing weight syntax only when the cursor has reached the tag's end.
    const end = cursor >= to ? Math.max(cursor, segmentEnd) : cursor
    const [following, spaces, separator] = /^([ \t]*)([,.|\r\n][ \t]*)?/.exec(text.slice(end))!
    const suffix = text.slice(cursor, end) + (separator ? following : `,${spaces || ' '}`)
    return { from, to: end + following.length, query, suffix }
}

function getImageTagDetail(tag: ImageTag): string {
    const category = imageTagCategories.find(([id]) => id === tag.category)?.[1] ?? 'general'
    const label = language.imageTagAutocomplete.categories[category]
    // NovelAI-only tags have no Danbooru post count; dataset tags always have one.
    return tag.count ? `${label} · ${tag.count.toLocaleString()}` : label
}

async function fetchImageTags(query: string, signal: AbortSignal): Promise<ImageTag[]> {
    const auth = await forageStorage.createAuth()
    signal.throwIfAborted()
    const params = new URLSearchParams({ q: query })
    const response = await fetch(`/api/image-tags?${params}`, { headers: { 'risu-auth': auth }, signal })
    if (!response.ok) throw new Error(`Image tag search failed: HTTP ${response.status}`)
    return (await response.json()).tags
}

export async function searchImagePromptSuggestions(
    query: string,
    signal: AbortSignal,
    onStatus: (status: ImageTagStatus) => void,
    { search = fetchImageTags, getBundles = () => [] }: ImagePromptSearchOptions = {},
): Promise<CompletionContent[]> {
    signal.throwIfAborted()
    onStatus('idle')
    if (isImageTagBundleQuery(query)) {
        return searchImageTagBundles(query, getBundles()).map(bundle => ({
            label: `### ${bundle.name}`, detail: bundle.source, description: bundle.content,
        }))
    }
    const timer = setTimeout(() => onStatus('loading'), INPUT_COMMIT_DEBOUNCE_MS)
    const cancelTimer = () => clearTimeout(timer)
    signal.addEventListener('abort', cancelTimer, { once: true })
    try {
        const tags = await search(query, signal)
        signal.throwIfAborted()
        onStatus('idle')
        return tags.map(tag => ({ label: tag.name, detail: getImageTagDetail(tag), description: tag.description }))
    } catch (error) {
        if (!signal.aborted) onStatus('error')
        throw error
    } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancelTimer)
    }
}

export function createImageTagCompletionSource({
    onStatus = () => {},
    ...searchOptions
}: ImagePromptSearchOptions & {
    onStatus?: (status: ImageTagStatus) => void
} = {}): CompletionSource {
    let sequence = 0
    return async context => {
        const request = ++sequence
        const selection = context.state.selection.main
        const composing = context.view?.compositionStarted
        const range = selection.empty || composing
            ? getImageTagRange(context.state.doc.toString(), composing ? selection.to : context.pos) : null
        if (!range) { onStatus('idle'); return null }
        const controller = new AbortController()
        context.addEventListener('abort', () => {
            controller.abort()
            if (sequence === request) onStatus('idle')
        }, { onDocChange: true })
        try {
            const suggestions = await searchImagePromptSuggestions(range.query, controller.signal, status => {
                if (sequence === request) onStatus(status)
            }, searchOptions)
            if (context.aborted || !suggestions.length) return null
            return {
                from: range.from,
                to: range.to,
                // Both sources return filtered results in display order.
                filter: false,
                options: suggestions.map(suggestion => ({
                    ...suggestion,
                    apply: suggestion.label + range.suffix,
                })),
            }
        } catch { return null }
    }
}

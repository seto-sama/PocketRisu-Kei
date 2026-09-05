export interface RenderedMarkdownBlock {
    key: string
    source: string
    html: string
}

export interface StreamingMarkdownRender {
    stableBlocks: RenderedMarkdownBlock[]
    tail: RenderedMarkdownBlock
    html: string
}

export interface StableMarkdownSplit {
    stableBlocks: string[]
    tail: string
}

const blankLineBoundary = /\r?\n[\t ]*\r?\n+/g
const unsafeBlockLine = /^(?:[\t ]{4}|[\t ]{0,3}(?:```|~~~|>|[-+*][\t ]|\d{1,9}\.[\t ]|<[!/?A-Za-z]|\[[^\]]+\]:))/
const stableHtmlBlockTags = new Set([
    'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div',
    'fieldset', 'figure', 'footer', 'form', 'header', 'main', 'nav', 'ol',
    'pre', 'script', 'section', 'style', 'table', 'ul',
])
const rawClosingPatterns = new Map<string, RegExp>()
const nestedTagPatterns = new Map<string, RegExp>()

function getReusablePattern(cache: Map<string, RegExp>, tag: string, source: string) {
    let pattern = cache.get(tag)
    if (!pattern) {
        pattern = new RegExp(source, 'ig')
        cache.set(tag, pattern)
    }
    pattern.lastIndex = 0
    return pattern
}

function includeTrailingWhitespace(source: string, end: number) {
    const trailing = source.slice(end).match(/^[\t ]*(?:\r?\n)*/)?.[0] ?? ''
    return end + trailing.length
}

function findCompleteHtmlBlockEnd(source: string, start: number): number | null {
    const rest = source.slice(start)
    const opening = rest.match(/^[\t \r\n]*<([A-Za-z][\w:-]*)\b[^>]*>/)
    if (!opening) return null
    const tag = opening[1].toLowerCase()
    if (!stableHtmlBlockTags.has(tag)) return null

    const openingEnd = start + opening[0].length
    if (opening[0].endsWith('/>')) return includeTrailingWhitespace(source, openingEnd)

    // Style/script contents are raw text; tag-like strings inside CSS or JS
    // must not participate in the nesting counter.
    if (tag === 'style' || tag === 'script') {
        const closingPattern = getReusablePattern(
            rawClosingPatterns,
            tag,
            `</${tag}\\s*>`,
        )
        closingPattern.lastIndex = openingEnd
        const closing = closingPattern.exec(source)
        return closing
            ? includeTrailingWhitespace(source, closing.index + closing[0].length)
            : null
    }

    const tagPattern = getReusablePattern(
        nestedTagPatterns,
        tag,
        `<(/?)${tag}\\b[^>]*>`,
    )
    tagPattern.lastIndex = openingEnd
    let depth = 1
    for (let match = tagPattern.exec(source); match; match = tagPattern.exec(source)) {
        if (match[1]) depth -= 1
        else if (!match[0].endsWith('/>')) depth += 1
        if (depth === 0) {
            return includeTrailingWhitespace(source, match.index + match[0].length)
        }
    }
    return null
}

function findCompleteCbsBlockEnd(source: string, start: number): number | null {
    const leadingLength = source.slice(start).match(/^[\t \r\n]*/)?.[0].length ?? 0
    const contentStart = start + leadingLength
    if (!source.startsWith('{{#when::', contentStart)) return null

    const tokenPattern = /{{#when::|{{\/when}}/g
    tokenPattern.lastIndex = contentStart
    let depth = 0
    for (let match = tokenPattern.exec(source); match; match = tokenPattern.exec(source)) {
        if (match[0] === '{{#when::') depth += 1
        else depth -= 1
        if (depth === 0) return includeTrailingWhitespace(source, match.index + match[0].length)
    }
    return null
}

function findCompleteStructuredBlockEnd(source: string, start: number) {
    return findCompleteHtmlBlockEnd(source, start) ?? findCompleteCbsBlockEnd(source, start)
}

function shouldDeferStructuredTail(source: string) {
    const content = source.trimStart()
    if (/^{{#when::/.test(content)) return true
    const tag = content.match(/^<([A-Za-z][\w:-]*)\b/)?.[1]?.toLowerCase()
    return tag ? stableHtmlBlockTags.has(tag) : false
}

/**
 * Only freeze self-contained prose blocks. Complex Markdown remains in the
 * mutable tail because later input may extend a list/fence/HTML block or
 * define a reference used by earlier text.
 */
export function splitStableMarkdownBlocks(source: string): StableMarkdownSplit {
    const stableBlocks: string[] = []
    let blockStart = 0

    while (blockStart < source.length) {
        const structuredEnd = findCompleteStructuredBlockEnd(source, blockStart)
        if (structuredEnd !== null) {
            stableBlocks.push(source.slice(blockStart, structuredEnd))
            blockStart = structuredEnd
            continue
        }

        blankLineBoundary.lastIndex = blockStart
        const match = blankLineBoundary.exec(source)
        if (!match) break
        const blockEnd = match.index + match[0].length
        const block = source.slice(blockStart, blockEnd)
        if (!isStableMarkdownBlock(block)) break
        stableBlocks.push(block)
        blockStart = blockEnd
    }

    return {
        stableBlocks,
        tail: source.slice(blockStart),
    }
}

function isStableMarkdownBlock(source: string) {
    const content = source.trim()
    if (!content) return false
    if (/[<>`|{}]/.test(content) || content.includes('$$') || content.includes('{{')) {
        return false
    }
    // Inline and shortcut reference links can be reinterpreted by a definition
    // appended later, so retain every bracketed block in the mutable tail.
    if (content.includes('[') || content.includes(']')) return false
    return !content.split(/\r?\n/).some(line => unsafeBlockLine.test(line))
}

function blockKey(index: number, source: string) {
    let hash = 2166136261
    for (let offset = 0; offset < source.length; offset++) {
        hash ^= source.charCodeAt(offset)
        hash = Math.imul(hash, 16777619)
    }
    return `${index}:${(hash >>> 0).toString(36)}`
}

export class StreamingMarkdownBlockRenderer {
    private contextKey = ''
    private stableBlocks: RenderedMarkdownBlock[] = []
    private stableHtml = ''

    reset() {
        this.contextKey = ''
        this.stableBlocks = []
        this.stableHtml = ''
    }

    async renderFinal(
        source: string,
        parse: (source: string) => Promise<string>,
    ) {
        this.reset()
        return parse(source)
    }

    async render(
        source: string,
        contextKey: string,
        parse: (source: string) => Promise<string>,
    ): Promise<StreamingMarkdownRender> {
        if (this.contextKey !== contextKey) {
            this.contextKey = contextKey
            this.stableBlocks = []
            this.stableHtml = ''
        }

        const split = splitStableMarkdownBlocks(source)
        let matchingBlocks = 0
        while (
            matchingBlocks < this.stableBlocks.length
            && matchingBlocks < split.stableBlocks.length
            && this.stableBlocks[matchingBlocks].source === split.stableBlocks[matchingBlocks]
        ) {
            matchingBlocks += 1
        }
        if (matchingBlocks < this.stableBlocks.length) {
            this.stableBlocks = this.stableBlocks.slice(0, matchingBlocks)
            this.stableHtml = this.stableBlocks.map(block => block.html).join('')
        }

        for (let index = matchingBlocks; index < split.stableBlocks.length; index++) {
            const blockSource = split.stableBlocks[index]
            const renderedBlock = {
                key: blockKey(index, blockSource),
                source: blockSource,
                html: await parse(blockSource),
            }
            this.stableBlocks.push(renderedBlock)
            this.stableHtml += renderedBlock.html
        }

        const tail = {
            key: `tail:${this.stableBlocks.length}`,
            source: split.tail,
            html: split.tail && !shouldDeferStructuredTail(split.tail)
                ? await parse(split.tail)
                : '',
        }
        const stableBlocks = [...this.stableBlocks]
        return {
            stableBlocks,
            tail,
            html: this.stableHtml + tail.html,
        }
    }
}

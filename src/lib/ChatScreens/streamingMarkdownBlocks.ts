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

/**
 * Only freeze self-contained prose blocks. Complex Markdown remains in the
 * mutable tail because later input may extend a list/fence/HTML block or
 * define a reference used by earlier text.
 */
export function splitStableMarkdownBlocks(source: string): StableMarkdownSplit {
    const stableBlocks: string[] = []
    let blockStart = 0
    blankLineBoundary.lastIndex = 0

    for (let match = blankLineBoundary.exec(source); match; match = blankLineBoundary.exec(source)) {
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

    reset() {
        this.contextKey = ''
        this.stableBlocks = []
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
        }

        for (let index = matchingBlocks; index < split.stableBlocks.length; index++) {
            const blockSource = split.stableBlocks[index]
            this.stableBlocks.push({
                key: blockKey(index, blockSource),
                source: blockSource,
                html: await parse(blockSource),
            })
        }

        const tail = {
            key: `tail:${this.stableBlocks.length}`,
            source: split.tail,
            html: split.tail ? await parse(split.tail) : '',
        }
        const stableBlocks = [...this.stableBlocks]
        return {
            stableBlocks,
            tail,
            html: stableBlocks.map(block => block.html).join('') + tail.html,
        }
    }
}

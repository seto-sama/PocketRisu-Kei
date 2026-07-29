export interface ExtractedThinking {
    text: string
    reasoning?: string
}

export function extractThinkTags(source: string): ExtractedThinking {
    const thoughts: string[] = []
    const text = source.replace(/<think>([\s\S]*?)(?:<\/think>|$)/giu, (_match, thought: string) => {
        if (thought.length > 0) thoughts.push(thought)
        return ''
    })
    return {
        text,
        reasoning: thoughts.length > 0 ? thoughts.join('\n') : undefined,
    }
}

export class ThinkTagStreamParser {
    private buffer = ''
    private inThinking = false

    push(chunk: string): ExtractedThinking {
        this.buffer += chunk
        return this.drain(false)
    }

    finish(): ExtractedThinking {
        return this.drain(true)
    }

    private drain(flush: boolean): ExtractedThinking {
        let text = ''
        let reasoning = ''
        const opening = '<think>'
        const closing = '</think>'

        while (this.buffer.length > 0) {
            const target = this.inThinking ? closing : opening
            const index = this.buffer.toLowerCase().indexOf(target)
            if (index >= 0) {
                const before = this.buffer.slice(0, index)
                if (this.inThinking) reasoning += before
                else text += before
                this.buffer = this.buffer.slice(index + target.length)
                this.inThinking = !this.inThinking
                continue
            }

            const retained = flush ? 0 : partialTagSuffixLength(this.buffer, target)
            const ready = this.buffer.slice(0, this.buffer.length - retained)
            if (this.inThinking) reasoning += ready
            else text += ready
            this.buffer = this.buffer.slice(this.buffer.length - retained)
            break
        }

        return {
            text,
            reasoning: reasoning.length > 0 ? reasoning : undefined,
        }
    }
}

function partialTagSuffixLength(value: string, tag: string): number {
    const normalized = value.toLowerCase()
    for (let length = Math.min(value.length, tag.length - 1); length > 0; length--) {
        if (normalized.endsWith(tag.slice(0, length))) return length
    }
    return 0
}

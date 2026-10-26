import type {
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterReasoningPart,
    AdapterUsage,
} from './types'

/** A provider response after adapter decoding, without provider wire payloads. */
export type DecodedChatEvent =
    | { type: 'delta', delta: Omit<AdapterChatStreamDelta, 'raw'> }
    | { type: 'response', response: Omit<AdapterChatResponse, 'raw'> }

export interface DecodedChatProgress {
    thinking: string
    response: string
    usage?: AdapterUsage
    awaitingProviderResult?: boolean
}

/** Serializes one event as an NDJSON line. */
export function encodeDecodedChatEvent(event: DecodedChatEvent): string {
    return `${JSON.stringify(event)}\n`
}

/**
 * Reads NDJSON decoded events. A trailing line without its newline is an
 * interrupted write and is not an event.
 */
export async function* readDecodedChatEvents(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<DecodedChatEvent, void, void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) return
            buffer += decoder.decode(value, { stream: true })
            let newline = buffer.indexOf('\n')
            while (newline !== -1) {
                const line = buffer.slice(0, newline)
                buffer = buffer.slice(newline + 1)
                if (line) yield JSON.parse(line) as DecodedChatEvent
                newline = buffer.indexOf('\n')
            }
        }
    } finally {
        reader.releaseLock()
    }
}

export function formatAdapterReasoning(reasoning?: AdapterReasoningPart[]): string {
    if (!reasoning?.length) return ''
    let body = ''
    for (const part of reasoning) {
        if (part.redactedData !== undefined) body += '\n{{redacted_thinking}}\n'
        else if (part.text) body += part.text
    }
    return body.trim().length > 0 ? `<Thoughts>\n${body}\n</Thoughts>\n\n` : ''
}

function isToolFinish(finishReason?: string): boolean {
    return finishReason === 'tool_calls' || finishReason === 'tool_use'
}

/** Folds decoded events into the message text and request progress. */
export function createDecodedChatProjection() {
    let reasoning: AdapterReasoningPart[] = []
    let text = ''
    let usage: AdapterUsage | undefined
    let awaitingProviderResult = false

    return {
        apply(event: DecodedChatEvent) {
            if (event.type === 'response') {
                const response = event.response
                reasoning = (response.reasoning ?? []).map(part => ({ ...part }))
                text = response.text
                usage = response.usage ?? usage
                // Tool calls and generated media are finished by the browser
                // (tool execution, inlay storage) and posted back as the result.
                awaitingProviderResult ||= !!response.toolCalls?.length
                    || !!response.media?.length
                    || isToolFinish(response.finishReason)
                return
            }
            const delta = event.delta
            text += delta.textDelta
            if (delta.reasoningDelta) {
                const last = reasoning.at(-1)
                if (last && last.text !== undefined && last.redactedData === undefined) last.text += delta.reasoningDelta
                else reasoning.push({ text: delta.reasoningDelta })
            }
            usage = delta.usage ?? usage
            awaitingProviderResult ||= isToolFinish(delta.finishReason)
        },
        content(): string {
            return formatAdapterReasoning(reasoning) + text
        },
        progress(): DecodedChatProgress {
            return {
                thinking: reasoning.map(part => part.text ?? '').join(''),
                response: text,
                ...(usage ? { usage } : {}),
                ...(awaitingProviderResult ? { awaitingProviderResult: true } : {}),
            }
        },
    }
}

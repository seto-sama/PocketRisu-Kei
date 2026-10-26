import { ModelPresetAdapterError, normalizeFetchError } from './error'
import type {
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterError,
    AdapterReasoningPart,
    AdapterUsage,
} from './types'

/**
 * A provider response after the server ran the adapter's decoder. `error`
 * carries a decoding failure so the adapter can rethrow it as its own error.
 */
export type DecodedChatEvent =
    | { type: 'delta', delta: AdapterChatStreamDelta }
    | { type: 'response', response: AdapterChatResponse }
    | { type: 'error', error: Omit<AdapterError, 'cause'> }

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

export function decodedChatErrorEvent(error: unknown): DecodedChatEvent {
    const adapterError = error instanceof ModelPresetAdapterError
        ? error
        : new ModelPresetAdapterError('parse', error instanceof Error ? error.message : String(error))
    const { cause: _cause, ...serialized } = adapterError.toAdapterError()
    return { type: 'error', error: serialized }
}

function rethrowDecodedError(error: Omit<AdapterError, 'cause'>): never {
    throw new ModelPresetAdapterError(error.kind, error.message, error)
}

/** Reads the server-decoded result of a non-streaming chat request. */
export async function readDecodedChatResponse(response: Response): Promise<AdapterChatResponse> {
    if (!response.body) throw new ModelPresetAdapterError('parse', 'Decoded chat response has no body')
    let decoded: AdapterChatResponse | undefined
    try {
        for await (const event of readDecodedChatEvents(response.body)) {
            if (event.type === 'error') rethrowDecodedError(event.error)
            if (event.type === 'response') decoded = event.response
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
    if (!decoded) throw new ModelPresetAdapterError('parse', 'Chat response ended before it was decoded')
    return decoded
}

/** Reads the server-decoded deltas of a streaming chat request. */
export async function* readDecodedChatStream(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    try {
        for await (const event of readDecodedChatEvents(stream)) {
            if (event.type === 'error') rethrowDecodedError(event.error)
            if (event.type === 'delta') yield event.delta
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
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
            // A decoding failure ends the events; the job's status reports it.
            if (event.type === 'error') return
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

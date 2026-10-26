import { getModelPresetAdapterDefinition } from './registry'
import {
    createThoughtSignatureCollector,
    supportsThoughtSignatures,
    type ThoughtSignatureContext,
} from './thoughtSignatures'
import type {
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterReasoningPart,
    AdapterResponseDecoder,
    AdapterUsage,
} from './types'

const DECODER_ADAPTER_KINDS: ReadonlySet<string> = new Set<AdapterResponseDecoder['adapterKind']>([
    'openai-compatible',
    'openai-responses',
    'anthropic-messages',
    'google-gemini',
    'amazon-bedrock',
])

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

/** Validates a decoder received from an untrusted request. */
export function parseAdapterResponseDecoder(value: unknown): AdapterResponseDecoder | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const input = value as Record<string, unknown>
    if (typeof input.adapterKind !== 'string' || !DECODER_ADAPTER_KINDS.has(input.adapterKind)) return undefined
    if (typeof input.stream !== 'boolean') return undefined
    const decoder: AdapterResponseDecoder = {
        adapterKind: input.adapterKind as AdapterResponseDecoder['adapterKind'],
        stream: input.stream,
    }
    const reasoning = input.reasoning as Record<string, unknown> | undefined
    if (reasoning !== undefined) {
        if (typeof reasoning?.includeNative !== 'boolean' || typeof reasoning.thinkTagFallback !== 'boolean') {
            return undefined
        }
        decoder.reasoning = {
            includeNative: reasoning.includeNative,
            thinkTagFallback: reasoning.thinkTagFallback,
        }
    }
    if (input.imageGeneration === true) decoder.imageGeneration = true
    if (input.batchCustomId !== undefined) {
        if (typeof input.batchCustomId !== 'string' || input.batchCustomId.length > 256) return undefined
        decoder.batchCustomId = input.batchCustomId
    }
    return decoder
}

/**
 * Runs the adapter's own decoder over a provider response body. This is the
 * single interpretation of a provider response; callers only see the events.
 */
export async function decodeAdapterResponseBody(
    decoder: AdapterResponseDecoder,
    body: ReadableStream<Uint8Array>,
    emit: (event: DecodedChatEvent) => void,
    onThoughtContext?: (context: ThoughtSignatureContext) => void,
): Promise<void> {
    const definition = getModelPresetAdapterDefinition(decoder.adapterKind)
    const signatures = onThoughtContext && supportsThoughtSignatures(decoder.adapterKind)
        ? createThoughtSignatureCollector(decoder.adapterKind)
        : undefined
    if (decoder.stream) {
        for await (const { raw: _raw, ...delta } of definition.decodeStream(body, decoder, signatures?.add)) {
            emit({ type: 'delta', delta })
        }
    } else {
        const text = await new Response(body).text()
        const { raw: _raw, ...response } = definition.decodeResponse(text, decoder, signatures?.add)
        emit({ type: 'response', response })
    }
    const context = signatures?.finish()
    if (context) onThoughtContext?.(context)
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
                awaitingProviderResult ||= !!response.toolCalls?.length || isToolFinish(response.finishReason)
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

import { getModelPresetAdapterDefinition } from './registry'
import {
    createThoughtSignatureCollector,
    supportsThoughtSignatures,
    type ThoughtSignatureContext,
} from './thoughtSignatures'
import type { DecodedChatEvent } from './decodedEvents'
import type { AdapterResponseDecoder } from './types'

const DECODER_ADAPTER_KINDS: ReadonlySet<string> = new Set<AdapterResponseDecoder['adapterKind']>([
    'openai-compatible',
    'openai-responses',
    'anthropic-messages',
    'google-gemini',
    'amazon-bedrock',
])

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
 * The thought context collected so far is reported even when decoding fails,
 * so a caller that keeps a partial result can keep its context too.
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
    try {
        if (decoder.stream) {
            for await (const { raw: _raw, ...delta } of definition.decodeStream(body, decoder, signatures?.add)) {
                emit({ type: 'delta', delta })
            }
        } else {
            const text = await new Response(body).text()
            const { raw: _raw, ...response } = definition.decodeResponse(text, decoder, signatures?.add)
            emit({ type: 'response', response })
        }
    } finally {
        const context = signatures?.finish()
        if (context) onThoughtContext?.(context)
    }
}

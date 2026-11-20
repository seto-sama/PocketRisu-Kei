import { beginGeminiCacheTurn, type GeminiCacheTurn } from '../cache/geminiCacheWiring'
import type { ModelPreset } from '../types'
import { ModelPresetAdapterError, normalizeFetchError } from './error'
import { prepareAdapterRequest } from './resolveCredential'
import { readDecodedChatResponse, readDecodedChatStream } from './decodedEvents'
import { parseResponseJson, preparedRequestFetch, sendPreparedRequest } from './httpTransport'
import { parseSseStream } from './sse'
import type {
    AdapterChatMessage,
    AdapterChatOptions,
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterCredential,
    AdapterGeneratedMedia,
    AdapterPreparedRequest,
    AdapterReasoningPart,
    AdapterToolCall,
    AdapterToolDef,
    AdapterUsage,
} from './types'
import { resolveWireModelId } from './wireInvariants'
import { restoreGeminiParts } from './thoughtSignatures'
import {
    hasCustomFlag,
    hasFixedImageOutput,
    hasPresetFlag,
    hasPresetImageOutput,
    isCustomPreset,
    resolveCustomGeminiEndpoint,
    resolveCustomReasoningEffort,
} from './customPreset'

export interface GeminiPart {
    text?: string
    thought?: boolean
    thoughtSignature?: string
    inlineData?: { mimeType: string; data: string }
    functionCall?: { id?: string; name: string; args: unknown }
    functionResponse?: { id?: string; name: string; response: unknown }
}

interface GeminiContent {
    role: 'user' | 'model'
    parts: GeminiPart[]
}

interface GeminiPreparedRequest extends AdapterPreparedRequest {
    modelId: string
    cacheBoundary: number | null
}

function beginCacheTurn(
    prepared: GeminiPreparedRequest,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
): GeminiCacheTurn | null {
    if (!options.cache) return null
    return beginGeminiCacheTurn({
        cache: options.cache,
        url: prepared.url,
        headers: prepared.headers,
        body: prepared.body,
        modelId: prepared.modelId,
        credentialKey: credential?.apiKey,
        boundaryIndex: prepared.cacheBoundary,
        fetchImpl: preparedRequestFetch(prepared, options),
    })
}

export async function sendGoogleChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = await prepareGeminiBody(preset, options, credential, false)
    const cacheTurn = beginCacheTurn(prepared, options, credential)
    const response = await sendGeminiRequest(prepared, options, cacheTurn, false)
    const parsed = await readDecodedChatResponse(response)
    cacheTurn?.finish(parsed.usage?.promptTokens)
    return parsed
}

export async function* streamGoogleChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareGeminiBody(preset, options, credential, true)
    const cacheTurn = beginCacheTurn(prepared, options, credential)
    const response = await sendGeminiRequest(prepared, options, cacheTurn, true)
    if (!response.body) {
        throw new ModelPresetAdapterError('parse', 'Gemini stream response has no body')
    }

    // Finish caching only after the stream completes, using its final usage.
    let lastUsage: AdapterUsage | undefined
    for await (const delta of readDecodedChatStream(response.body)) {
        if (delta.usage) lastUsage = delta.usage
        yield delta
    }
    cacheTurn?.finish(lastUsage?.promptTokens)
}

async function sendGeminiRequest(
    prepared: GeminiPreparedRequest,
    options: AdapterChatOptions,
    cacheTurn: GeminiCacheTurn | null,
    stream: boolean,
): Promise<Response> {
    const send = (body: Record<string, unknown>) => sendPreparedRequest(
        { ...prepared, body }, options, {
            accept: stream ? 'text/event-stream' : undefined,
            responseDecoder: { adapterKind: 'google-gemini', stream },
        },
    )
    try {
        return await send(cacheTurn ? cacheTurn.body : prepared.body)
    } catch (err) {
        if (!cacheTurn?.appliedCache || !(err instanceof ModelPresetAdapterError)
            || (err.status !== 403 && err.status !== 404)) throw err
        // A missing or inaccessible cache gets one retry with the full prompt.
        cacheTurn.invalidateAppliedCache()
        return send(prepared.body)
    }
}

export function decodeGeminiResponse(body: string, onRaw?: (raw: unknown) => void): AdapterChatResponse {
    const raw = parseResponseJson(body, 'Failed to parse Gemini JSON response')
    onRaw?.(raw)
    return parseGeminiResponse(raw)
}

export async function* decodeGeminiStream(
    stream: ReadableStream<Uint8Array>,
    onRaw?: (raw: unknown) => void,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    try {
        for await (const event of parseSseStream(stream)) {
            if (event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (err) {
                throw new ModelPresetAdapterError(
                    'parse',
                    'Failed to parse Gemini stream chunk JSON',
                    { cause: err },
                )
            }
            onRaw?.(raw)
            const delta = parseGeminiStreamDelta(raw)
            if (delta) yield delta
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

export function previewGoogleChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterPreparedRequest> {
    return prepareGeminiBody(preset, options, credential, false)
}

async function prepareGeminiBody(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
    stream: boolean,
): Promise<GeminiPreparedRequest> {
    const prepared = await prepareAdapterRequest({
        preset,
        credential,
        tokenCache: options.tokenCache,
        abortSignal: options.abortSignal,
    })
    // Prompt structure and the URL model come from the request, overriding customBody.
    const modelId = resolveWireModelId(preset, { vendorName: 'Google Gemini' })
    delete prepared.body.model

    const { system, chat, systemCachePoint } = collectSystemAndChat(options.messages)
    const { contents, cacheBoundary } = toGeminiContents(chat)
    // Boundary 0 caches only systemInstruction; a chat cache point covers a larger prefix.
    const resolvedBoundary = cacheBoundary ?? (systemCachePoint ? 0 : null)
    delete prepared.body.systemInstruction
    delete prepared.body.contents
    if (system.length > 0) {
        prepared.body.systemInstruction = { parts: [{ text: system }] }
    }
    prepared.body.contents = contents
    if (options.tools && options.tools.length > 0) {
        prepared.body.tools = [{ functionDeclarations: options.tools.map(toGeminiFunctionDeclaration) }]
    } else {
        // Also remove customBody tool controls when tools are disabled.
        delete prepared.body.tools
        delete prepared.body.toolConfig
    }
    const generationConfig = isPlainObject(prepared.body.generationConfig)
        ? { ...prepared.body.generationConfig }
        : {}
    applyVisionQuality(generationConfig, preset)
    if (options.structuredOutput) {
        generationConfig.responseMimeType = 'application/json'
        generationConfig.responseJsonSchema = options.structuredOutput.schema
    } else {
        delete generationConfig.responseMimeType
        delete generationConfig.responseJsonSchema
    }
    applyIncludeThoughts(generationConfig, preset)
    applyResponseModalities(generationConfig, preset)
    if (Object.keys(generationConfig).length > 0) prepared.body.generationConfig = generationConfig
    else delete prepared.body.generationConfig

    const customEndpoint = resolveCustomGeminiEndpoint(preset, prepared.url, modelId, stream)
    if (customEndpoint) {
        prepared.url = customEndpoint
    } else {
        const suffix = stream ? ':streamGenerateContent?alt=sse' : ':generateContent'
        prepared.url = `${prepared.url}/${encodeURIComponent(modelId)}${suffix}`
    }
    return { ...prepared, modelId, cacheBoundary: resolvedBoundary }
}

function applyIncludeThoughts(
    generationConfig: Record<string, unknown>,
    preset: ModelPreset,
): void {
    const thinkingConfig = isPlainObject(generationConfig.thinkingConfig)
        ? { ...generationConfig.thinkingConfig }
        : {}
    const hasStandardThinking = thinkingConfig.thinkingLevel !== undefined
        || thinkingConfig.thinkingBudget !== undefined
    const shouldInclude = isCustomPreset(preset)
        ? resolveCustomReasoningEffort(preset) !== undefined
            || hasCustomFlag(preset, 'geminiIncludeThoughts')
        : hasStandardThinking
    if (!shouldInclude) return

    thinkingConfig.includeThoughts = true
    generationConfig.thinkingConfig = thinkingConfig
}

function applyResponseModalities(
    generationConfig: Record<string, unknown>,
    preset: ModelPreset,
): void {
    const imageOutput = hasPresetImageOutput(preset)
    const audioOutput = hasPresetFlag(preset, 'hasAudioOutput')
    if (!imageOutput && !audioOutput) return

    generationConfig.responseModalities = imageOutput
        ? hasFixedImageOutput(preset) ? ['IMAGE'] : ['TEXT', 'IMAGE']
        : ['TEXT', 'AUDIO']
}

function applyVisionQuality(
    generationConfig: Record<string, unknown>,
    preset: ModelPreset,
): void {
    const quality = preset.gptVisionQuality
    if (quality === undefined) return
    if (quality === 'low' || quality === 'medium' || quality === 'high') {
        generationConfig.mediaResolution = `MEDIA_RESOLUTION_${quality.toUpperCase()}`
    } else {
        delete generationConfig.mediaResolution
    }
}

function toGeminiFunctionDeclaration(tool: AdapterToolDef): Record<string, unknown> {
    return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

function collectSystemAndChat(messages: AdapterChatMessage[]): {
    system: string
    chat: AdapterChatMessage[]
    systemCachePoint: boolean
} {
    const systems: string[] = []
    const chat: AdapterChatMessage[] = []
    let systemCachePoint = false
    for (const message of messages) {
        if (message.role === 'system') {
            systems.push(message.content)
            if (message.cachePoint) systemCachePoint = true
        } else {
            chat.push(message)
        }
    }
    return { system: systems.join('\n\n'), chat, systemCachePoint }
}

// Group adjacent tool results into user turns. Track the cache boundary in
// emitted contents so grouping cannot shift it away from the marked message.
function toGeminiContents(chat: AdapterChatMessage[]): {
    contents: GeminiContent[]
    cacheBoundary: number | null
} {
    const out: GeminiContent[] = []
    let pendingFnResponses: GeminiPart[] = []
    let cacheBoundary: number | null = null
    let pendingCachePoint = false

    const flush = () => {
        if (pendingFnResponses.length > 0) {
            out.push({ role: 'user', parts: pendingFnResponses })
            pendingFnResponses = []
            if (pendingCachePoint) {
                cacheBoundary = out.length
                pendingCachePoint = false
            }
        }
    }

    for (const message of chat) {
        if (message.role === 'tool') {
            const functionResponse: NonNullable<GeminiPart['functionResponse']> = {
                name: message.name ?? '',
                response: { result: message.content },
            }
            // IDs distinguish parallel calls to the same tool.
            if (message.toolCallId) functionResponse.id = message.toolCallId
            pendingFnResponses.push({ functionResponse })
            if (message.cachePoint) pendingCachePoint = true
            continue
        }
        flush()
        if (message.role === 'assistant') {
            const parts = Array.isArray(message.providerEcho)
                ? (message.providerEcho as GeminiPart[])
                : restoreGeminiParts(message, parseToolArgs) ?? toModelParts(message)
            out.push({ role: 'model', parts })
        } else {
            out.push({ role: 'user', parts: toUserParts(message) })
        }
        if (message.cachePoint) cacheBoundary = out.length
    }
    flush()
    return { contents: out, cacheBoundary }
}

function toUserParts(message: AdapterChatMessage): GeminiPart[] {
    const parts: GeminiPart[] = []
    if (message.content.length > 0) parts.push({ text: message.content })
    for (const img of message.images ?? []) {
        parts.push({ inlineData: { mimeType: img.mime ?? 'image/png', data: img.base64 } })
    }
    for (const media of message.media ?? []) {
        parts.push({
            inlineData: {
                mimeType: media.mime ?? (media.kind === 'audio' ? 'audio/mpeg' : 'video/mp4'),
                data: media.base64,
            },
        })
    }
    // Gemini rejects an empty parts array; keep at least one part.
    if (parts.length === 0) parts.push({ text: '' })
    return parts
}

function toModelParts(message: AdapterChatMessage): GeminiPart[] {
    const parts: GeminiPart[] = []
    for (const part of message.reasoning ?? []) {
        if (part.text !== undefined) {
            parts.push({ text: part.text, thought: true, thoughtSignature: part.signature })
        }
    }
    if (message.content.length > 0) {
        parts.push({ text: message.content })
    }
    for (const call of message.toolCalls ?? []) {
        const functionCall: NonNullable<GeminiPart['functionCall']> = { name: call.name, args: parseToolArgs(call.arguments) }
        if (call.id) functionCall.id = call.id
        const fc: GeminiPart = { functionCall }
        if (call.signature) fc.thoughtSignature = call.signature
        parts.push(fc)
    }
    if (parts.length === 0) parts.push({ text: '' })
    return parts
}

function parseToolArgs(args: string): unknown {
    if (!args) return {}
    try { return JSON.parse(args) }
    catch { return {} }
}

export function parseGeminiResponse(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw)) {
        throw new ModelPresetAdapterError('parse', 'Gemini response is not an object')
    }
    const candidates = raw['candidates']
    if (!Array.isArray(candidates) || candidates.length === 0) {
        // Prompt blocks must not be retried as malformed responses.
        throwIfPromptBlocked(raw['promptFeedback'])
        throw new ModelPresetAdapterError('parse', 'Gemini response has no candidates')
    }
    const first = candidates[0]
    if (!isPlainObject(first)) {
        throw new ModelPresetAdapterError('parse', 'First Gemini candidate is not an object')
    }
    const parsed = parseGeminiParts(first['content'])
    const finishReason = typeof first['finishReason'] === 'string'
        ? (first['finishReason'] as string)
        : undefined
    const echoParts = isPlainObject(first['content']) && Array.isArray((first['content'] as Record<string, unknown>)['parts'])
        ? (first['content'] as Record<string, unknown>)['parts']
        : undefined
    return {
        text: parsed.text,
        media: parsed.media.length > 0 ? parsed.media : undefined,
        toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
        reasoning: parsed.reasoning.length > 0 ? parsed.reasoning : undefined,
        // Replay signatures on their original parts, including plain text parts.
        providerEcho: echoParts,
        finishReason,
        usage: parseGeminiUsage(raw['usageMetadata']),
    }
}

function parseGeminiParts(content: unknown): {
    text: string
    toolCalls: AdapterToolCall[]
    reasoning: AdapterReasoningPart[]
    media: AdapterGeneratedMedia[]
} {
    const text: string[] = []
    const toolCalls: AdapterToolCall[] = []
    const reasoning: AdapterReasoningPart[] = []
    const media: AdapterGeneratedMedia[] = []
    if (isPlainObject(content) && Array.isArray(content['parts'])) {
        for (const part of content['parts']) {
            if (!isPlainObject(part)) continue
            const signature = typeof part['thoughtSignature'] === 'string'
                ? (part['thoughtSignature'] as string)
                : undefined
            const fn = part['functionCall']
            if (isPlainObject(fn) && typeof fn['name'] === 'string') {
                toolCalls.push({
                    // Missing provider IDs use name matching; storage assigns its own ID.
                    id: typeof fn['id'] === 'string' ? (fn['id'] as string) : '',
                    name: fn['name'] as string,
                    arguments: JSON.stringify(fn['args'] ?? {}),
                    signature,
                })
            } else if (part['thought'] === true && typeof part['text'] === 'string') {
                reasoning.push({ text: part['text'] as string, signature })
            } else if (isPlainObject(part['inlineData'])) {
                const inlineData = part['inlineData'] as Record<string, unknown>
                const mime = inlineData['mimeType']
                const data = inlineData['data']
                if (
                    typeof mime === 'string'
                    && typeof data === 'string'
                    && (mime.startsWith('image/') || mime.startsWith('audio/'))
                ) {
                    media.push({
                        kind: mime.startsWith('image/') ? 'image' : 'audio',
                        mime,
                        base64: data,
                    })
                }
            } else if (typeof part['text'] === 'string') {
                text.push(part['text'] as string)
            }
        }
    }
    return { text: text.join(''), toolCalls, reasoning, media }
}

export function parseGeminiStreamDelta(raw: unknown): AdapterChatStreamDelta | null {
    if (!isPlainObject(raw)) return null
    throwIfPromptBlocked(raw['promptFeedback'])
    const candidates = raw['candidates']
    let textDelta = ''
    let reasoningDelta = ''
    let finishReason: string | undefined
    if (Array.isArray(candidates) && candidates.length > 0 && isPlainObject(candidates[0])) {
        const first = candidates[0] as Record<string, unknown>
        const split = splitStreamParts(first['content'])
        textDelta = split.text
        reasoningDelta = split.reasoning
        if (typeof first['finishReason'] === 'string') {
            finishReason = first['finishReason'] as string
        }
    }
    const usage = parseGeminiUsage(raw['usageMetadata'])
    if (textDelta.length === 0 && reasoningDelta.length === 0 && finishReason === undefined && usage === undefined) {
        return null
    }
    return { textDelta, reasoningDelta: reasoningDelta.length > 0 ? reasoningDelta : undefined, finishReason, usage }
}

function throwIfPromptBlocked(feedback: unknown): void {
    if (!isPlainObject(feedback)) return
    const reason = feedback['blockReason']
    if (typeof reason !== 'string' || reason.length === 0) return
    const message = typeof feedback['blockReasonMessage'] === 'string' && (feedback['blockReasonMessage'] as string).length > 0
        ? (feedback['blockReasonMessage'] as string)
        : reason
    throw new ModelPresetAdapterError(
        'invalid-request',
        `Gemini blocked the prompt: ${message}`,
        { retryable: false, fallbackEligible: false },
    )
}

function splitStreamParts(content: unknown): { text: string; reasoning: string } {
    if (!isPlainObject(content)) return { text: '', reasoning: '' }
    const parts = content['parts']
    if (!Array.isArray(parts)) return { text: '', reasoning: '' }
    let text = ''
    let reasoning = ''
    for (const part of parts) {
        if (!isPlainObject(part) || typeof part['text'] !== 'string') continue
        if (part['thought'] === true) reasoning += part['text'] as string
        else text += part['text'] as string
    }
    return { text, reasoning }
}

function parseGeminiUsage(raw: unknown): AdapterUsage | undefined {
    if (!isPlainObject(raw)) return undefined
    const usage: AdapterUsage = {}
    if (typeof raw['promptTokenCount'] === 'number') {
        usage.promptTokens = raw['promptTokenCount'] as number
    }
    if (typeof raw['candidatesTokenCount'] === 'number') {
        usage.completionTokens = raw['candidatesTokenCount'] as number
    }
    if (typeof raw['totalTokenCount'] === 'number') {
        usage.totalTokens = raw['totalTokenCount'] as number
    }
    if (typeof raw['cachedContentTokenCount'] === 'number') {
        usage.cachedTokens = raw['cachedContentTokenCount'] as number
    }
    if (
        usage.promptTokens === undefined
        && usage.completionTokens === undefined
        && usage.totalTokens === undefined
        && usage.cachedTokens === undefined
    ) {
        return undefined
    }
    return usage
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

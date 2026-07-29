import type { ModelPreset } from '../types'
import {
    hasCustomFlag,
    hasCustomModelIdToken,
    hasPresetFlag,
    isCustomPreset,
} from './customPreset'
import { extractThinkTags, ThinkTagStreamParser } from '../thinkingTags'
import {
    ModelPresetAdapterError,
    normalizeFetchError,
} from './error'
import {
    openPreparedEventStream,
    sendPreparedJsonRequest,
} from './httpTransport'
import { prepareAdapterRequest } from './resolveCredential'
import { parseSseStream } from './sse'
import type {
    AdapterChatMessage,
    AdapterChatOptions,
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterCredential,
    AdapterImagePart,
    AdapterPreparedRequest,
    AdapterReasoningPart,
    AdapterToolCall,
    AdapterToolDef,
    AdapterUsage,
} from './types'
import { resolveWireModelId } from './wireInvariants'
import { applyOpenAiApiModeEndpoint } from './openaiApiMode'
import {
    applyBedrockAuthentication,
    resolveBedrockRegion,
} from './amazonBedrock'

interface WireToolCall {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
    // OpenRouter passes Gemini's thought signature through this OpenAI-compatible
    // extension. It must round-trip or thinking-enabled Gemini (via OpenRouter)
    // rejects the follow-up tool turn.
    extra_content?: { google?: { thought_signature?: string } }
}

// Content is a plain string for text turns, or the OpenAI multimodal content-part
// array `[{type:'text'...}, {type:'image_url'...}]` when a user turn carries images.
type WireContentPart =
    | { type: 'text'; text: string; prompt_cache_breakpoint?: { mode: 'explicit' } }
    | { type: 'image_url'; image_url: { url: string; detail?: OpenAiImageDetail }; prompt_cache_breakpoint?: { mode: 'explicit' } }

type OpenAiImageDetail = 'auto' | 'low' | 'high'

interface WireMessage {
    role: AdapterChatMessage['role']
    content: string | WireContentPart[]
    name?: string
    tool_call_id?: string
    tool_calls?: WireToolCall[]
    partial?: boolean
    prefix?: boolean
    reasoning_content?: string
}

type AssistantPrefillMode = 'kimi' | 'deepseek'

export async function sendChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = await prepareOpenAiBody(preset, options, credential, false)
    const raw = await sendPreparedJsonRequest(
        prepared,
        options,
        'Failed to parse OpenAI-compatible JSON response',
    )

    return isDirectImageGenerationPreset(preset)
        ? parseImageGenerationResponse(raw)
        : parseChatCompletion(raw, resolveReasoningOutputOptions(preset))
}

export async function* streamChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareOpenAiBody(preset, options, credential, true)
    const stream = await openPreparedEventStream(
        prepared,
        options,
        'OpenAI-compatible stream response has no body',
    )

    const reasoningOutput = resolveReasoningOutputOptions(preset)
    const thinkTagParser = reasoningOutput.thinkTagFallback
        ? new ThinkTagStreamParser()
        : undefined
    try {
        for await (const event of parseSseStream(stream)) {
            if (event.data === '[DONE]') break
            if (event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (err) {
                throw new ModelPresetAdapterError(
                    'parse',
                    'Failed to parse OpenAI-compatible stream chunk JSON',
                    { cause: err },
                )
            }
            const parsed = parseChatStreamDelta(raw, reasoningOutput.includeNative)
            const delta = parsed && thinkTagParser
                ? applyThinkTagStreamFallback(parsed, thinkTagParser)
                : parsed
            if (delta) yield delta
        }
        if (thinkTagParser) {
            const flushed = thinkTagParser.finish()
            if (flushed.text.length > 0 || flushed.reasoning) {
                yield {
                    textDelta: flushed.text,
                    reasoningDelta: flushed.reasoning,
                    raw: {},
                }
            }
        }
    } catch (err) {
        // Intentional domain errors (parse, etc.) pass through;
        // fetch/abort/network failures during stream body read get normalized.
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

// Build the request without sending it (previewBody). Must never hit the network
// or the tool loop.
export function previewChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterPreparedRequest> {
    return prepareOpenAiBody(preset, options, credential, false)
}

async function prepareOpenAiBody(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
    stream: boolean,
): Promise<AdapterPreparedRequest> {
    const prepared = await prepareAdapterRequest({
        preset,
        credential,
        abortSignal: options.abortSignal,
    })
    applyOpenAiApiModeEndpoint(preset, prepared)
    // messages, model, and stream are wire invariants per plan §4-5 and must
    // not be overridden by customBody. Resolve modelId from the preset's user
    // values / schema (not the customBody-merged body), then overwrite the
    // body fields after the shared merge so customBody collisions lose.
    const modelId = resolveWireModelId(preset, { vendorName: 'OpenAI-compatible' })
    if (isDirectImageGenerationPreset(preset)) {
        prepared.body = {
            model: modelId,
            prompt: imageGenerationPrompt(options.messages),
        }
        return prepared
    }
    const supportsPromptCacheBreakpoints = modelId.startsWith('gpt-5.6')
    const imageDetail = resolveImageDetail(preset)
    const lastMessageIndex = options.messages.length - 1
    const assistantPrefillMode = options.messages[lastMessageIndex]?.role === 'assistant'
        ? resolveAssistantPrefillMode(preset)
        : undefined
    const includeDeepSeekThinkingInput = assistantPrefillMode === 'deepseek'
        && hasPresetFlag(preset, 'deepSeekThinkingInput')
    applyDirectDeepSeekPrefillEndpoint(prepared, assistantPrefillMode)
    prepared.body.messages = options.messages.map(
        (message, index) => toWireMessage(
            message,
            supportsPromptCacheBreakpoints,
            imageDetail,
            index === lastMessageIndex ? assistantPrefillMode : undefined,
            index === lastMessageIndex && includeDeepSeekThinkingInput,
        ),
    )
    prepared.body.model = modelId
    prepared.body.stream = stream
    // OpenAI only emits usage for a streamed Chat Completions response when
    // include_usage is requested. Keep this first-party-only: arbitrary
    // OpenAI-compatible servers may reject the otherwise optional field.
    if (stream && preset.profileSnapshot.providerBaseId === 'openai') {
        const streamOptions = isPlainObject(prepared.body.stream_options)
            ? prepared.body.stream_options
            : {}
        prepared.body.stream_options = {
            ...streamOptions,
            include_usage: true,
        }
    }
    if (options.structuredOutput) {
        prepared.body.response_format = {
            type: 'json_schema',
            json_schema: {
                name: 'format',
                strict: options.structuredOutput.strict,
                schema: options.structuredOutput.schema,
            },
        }
    } else {
        delete prepared.body.response_format
    }
    if (!supportsPromptCacheBreakpoints) delete prepared.body.prompt_cache_options
    // `tools` is a wire invariant when the caller supplies them: the request
    // builder must own tool declaration so customBody cannot smuggle a
    // conflicting list. When absent, leave any profile-declared tools untouched.
    if (options.tools && options.tools.length > 0) {
        prepared.body.tools = options.tools.map(toWireToolDef)
    } else {
        // Tools are gated by the request, not customBody. With no tools on the
        // request (toggle off), strip any customBody-provided tools so the OFF
        // state is a hard gate — otherwise the model could emit tool calls the
        // inactive text path would silently drop.
        delete prepared.body.tools
    }
    // Tool-coupled fields are rejected by OpenAI-compatible APIs when no tools
    // are present ("parallel_tool_calls is only allowed when tools are
    // specified"). Profiles may default these (e.g. gpt-5.5 ships
    // parallel_tool_calls: true), so strip them on tool-less (text) requests.
    const hasTools = Array.isArray(prepared.body.tools) && prepared.body.tools.length > 0
    if (!hasTools) {
        delete prepared.body.parallel_tool_calls
        delete prepared.body.tool_choice
    }
    if (preset.profileSnapshot.endpoint.kind === 'amazon-bedrock-mantle') {
        return applyBedrockAuthentication(prepared, credential, resolveBedrockRegion(preset))
    }
    return prepared
}

function toWireToolDef(tool: AdapterToolDef): Record<string, unknown> {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }
}

function toWireMessage(
    message: AdapterChatMessage,
    supportsPromptCacheBreakpoints = false,
    imageDetail?: OpenAiImageDetail,
    assistantPrefillMode?: AssistantPrefillMode,
    includeDeepSeekThinkingInput = false,
): WireMessage {
    // Verbatim re-send of the model's own assistant turn (reasoning_details,
    // tool_calls, etc.) when we captured it this request. Reconstruction below is
    // the fallback for history-restored turns (no providerEcho).
    if (message.role === 'assistant' && isPlainObject(message.providerEcho)) {
        const wire = { ...message.providerEcho } as unknown as WireMessage
        applyAssistantPrefill(wire, assistantPrefillMode)
        applyDeepSeekThinkingInput(wire, message.reasoning, includeDeepSeekThinkingInput)
        return wire
    }
    const wire: WireMessage = {
        role: message.role,
        // A user turn with images becomes a content-part array; otherwise the
        // plain string (unchanged from text-only behavior).
        content: (message.role === 'user' && message.images && message.images.length > 0)
            || (message.cachePoint && supportsPromptCacheBreakpoints)
            ? toContentParts(
                message.content,
                message.role === 'user' ? (message.images ?? []) : [],
                message.cachePoint && supportsPromptCacheBreakpoints,
                imageDetail,
            )
            : message.content,
    }
    if (message.name !== undefined) wire.name = message.name
    if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId
    if (message.toolCalls && message.toolCalls.length > 0) {
        wire.tool_calls = message.toolCalls.map((call) => {
            const wireCall: WireToolCall = {
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
            }
            if (call.signature) {
                wireCall.extra_content = { google: { thought_signature: call.signature } }
            }
            return wireCall
        })
    }
    if (message.role === 'assistant') {
        applyAssistantPrefill(wire, assistantPrefillMode)
        applyDeepSeekThinkingInput(wire, message.reasoning, includeDeepSeekThinkingInput)
    }
    return wire
}

function resolveAssistantPrefillMode(preset: ModelPreset): AssistantPrefillMode | undefined {
    // Current profiles carry provider metadata, so they do not need model-ID
    // guessing. Developer Custom has no provider metadata and therefore keeps
    // the explicit opt-in plus its model-ID fallback.
    if (isCustomPreset(preset)) {
        if (!hasCustomFlag(preset, 'hasPrefill')) return undefined
        if (hasCustomModelIdToken(preset, 'kimi')) return 'kimi'
        if (hasCustomModelIdToken(preset, 'deepseek')) return 'deepseek'
        return undefined
    }

    if (preset.profileSnapshot.providerBaseId === 'moonshotai') return 'kimi'
    if (preset.profileSnapshot.providerBaseId === 'deepseek') return 'deepseek'
    return undefined
}

function applyAssistantPrefill(
    wire: WireMessage,
    mode: AssistantPrefillMode | undefined,
): void {
    if (mode === 'kimi') wire.partial = true
    else if (mode === 'deepseek') wire.prefix = true
}

function applyDeepSeekThinkingInput(
    wire: WireMessage,
    reasoning: AdapterReasoningPart[] | undefined,
    enabled: boolean,
): void {
    if (!enabled) return
    const text = reasoning
        ?.map((part) => part.text)
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n')
    if (text) wire.reasoning_content = text
}

function applyDirectDeepSeekPrefillEndpoint(
    prepared: AdapterPreparedRequest,
    mode: AssistantPrefillMode | undefined,
): void {
    if (mode !== 'deepseek') return
    try {
        const url = new URL(prepared.url)
        if (url.hostname.toLowerCase() !== 'api.deepseek.com') return
        if (/\/beta\/chat\/completions\/?$/u.test(url.pathname)) return
        if (!/\/chat\/completions\/?$/u.test(url.pathname)) return

        const basePath = url.pathname
            .replace(/\/chat\/completions\/?$/u, '')
            .replace(/\/v1\/?$/u, '')
        url.pathname = `${basePath}/beta/chat/completions`.replace(/^\/{2,}/u, '/')
        prepared.url = url.toString()
    } catch {
        // URL validation and reporting remain owned by the shared request builder.
    }
}

// Build the OpenAI multimodal content array: the text part (when non-empty)
// followed by one image_url part per image. The image_url URL is the `data:` URL
// reconstructed from the raw base64 + mime (OpenAI accepts data URLs directly).
function toContentParts(
    text: string,
    images: AdapterImagePart[],
    cachePoint = false,
    imageDetail?: OpenAiImageDetail,
): WireContentPart[] {
    const parts: WireContentPart[] = []
    if (text.length > 0) parts.push({ type: 'text', text })
    for (const img of images) {
        parts.push({
            type: 'image_url',
            image_url: {
                url: toDataUrl(img),
                ...(imageDetail ? { detail: imageDetail } : {}),
            },
        })
    }
    if (cachePoint && parts.length > 0) {
        parts[parts.length - 1].prompt_cache_breakpoint = { mode: 'explicit' }
    }
    return parts
}

function resolveImageDetail(preset: ModelPreset): OpenAiImageDetail | undefined {
    const value = preset.gptVisionQuality
    return value === 'auto' || value === 'low' || value === 'high' ? value : undefined
}

function toDataUrl(img: AdapterImagePart): string {
    return `data:${img.mime ?? 'image/png'};base64,${img.base64}`
}

interface ReasoningOutputOptions {
    includeNative: boolean
    thinkTagFallback: boolean
}

function isDirectImageGenerationPreset(preset: ModelPreset): boolean {
    return preset.profileSnapshot.providerBaseId === 'openai'
        && preset.profileSnapshot.endpoint.url?.includes('/images/generations') === true
}

function imageGenerationPrompt(messages: AdapterChatMessage[]): string {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    return lastUser?.content ?? messages.at(-1)?.content ?? ''
}

function parseImageGenerationResponse(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw) || !Array.isArray(raw['data'])) {
        throw new ModelPresetAdapterError('parse', 'OpenAI image response has no data')
    }
    const media = raw['data'].flatMap((item) => {
        if (!isPlainObject(item) || typeof item['b64_json'] !== 'string') return []
        return [{
            kind: 'image' as const,
            mime: 'image/png',
            base64: item['b64_json'] as string,
        }]
    })
    if (media.length === 0) {
        throw new ModelPresetAdapterError('parse', 'OpenAI image response has no generated image')
    }
    return {
        text: '',
        media,
        usage: parseUsage(raw['usage']),
        raw,
    }
}

function parseChatCompletion(
    raw: unknown,
    reasoningOptions: ReasoningOutputOptions = {
        includeNative: true,
        thinkTagFallback: false,
    },
): AdapterChatResponse {
    if (!isPlainObject(raw)) {
        throw new ModelPresetAdapterError('parse', 'OpenAI-compatible response is not an object')
    }
    const choices = raw['choices']
    if (!Array.isArray(choices) || choices.length === 0) {
        throw new ModelPresetAdapterError(
            'parse',
            'OpenAI-compatible response has no choices',
        )
    }
    const first = choices[0]
    if (!isPlainObject(first)) {
        throw new ModelPresetAdapterError('parse', 'First choice is not an object')
    }
    const message = first['message']
    let text = isPlainObject(message) && typeof message['content'] === 'string'
        ? (message['content'] as string)
        : ''
    const toolCalls = isPlainObject(message) ? parseToolCalls(message['tool_calls']) : undefined
    let reasoning = reasoningOptions.includeNative && isPlainObject(message)
        ? parseReasoning(message)
        : undefined
    if (!reasoning && reasoningOptions.thinkTagFallback) {
        const fallback = extractThinkTags(text)
        text = fallback.text
        if (fallback.reasoning) reasoning = [{ text: fallback.reasoning }]
    }
    const finishReason = typeof first['finish_reason'] === 'string'
        ? (first['finish_reason'] as string)
        : undefined
    return {
        text,
        toolCalls,
        reasoning,
        // Keep the raw assistant message so a tool follow-up resends it verbatim
        // (preserves reasoning_details / any provider extension OpenRouter requires).
        providerEcho: isPlainObject(message) ? message : undefined,
        finishReason,
        usage: parseUsage(raw['usage']),
        raw,
    }
}

// Surface the model's reasoning text for display only. OpenRouter exposes it as
// `reasoning`, some OpenAI-compatible servers (DeepSeek etc.) as
// `reasoning_content`. The opaque signature payload needed to ECHO reasoning back
// on a tool follow-up rides in providerEcho (reasoning_details), so this string
// is purely for the <Thoughts> display and need not round-trip.
function parseReasoning(message: Record<string, unknown>): AdapterReasoningPart[] | undefined {
    const raw = typeof message['reasoning'] === 'string'
        ? (message['reasoning'] as string)
        : typeof message['reasoning_content'] === 'string'
            ? (message['reasoning_content'] as string)
            : ''
    return raw.length > 0 ? [{ text: raw }] : undefined
}

function parseToolCalls(raw: unknown): AdapterToolCall[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined
    const calls: AdapterToolCall[] = []
    for (const entry of raw) {
        if (!isPlainObject(entry)) continue
        const fn = entry['function']
        if (!isPlainObject(fn) || typeof fn['name'] !== 'string') continue
        const args = typeof fn['arguments'] === 'string' ? (fn['arguments'] as string) : ''
        const id = typeof entry['id'] === 'string' ? (entry['id'] as string) : ''
        const signature = extractThoughtSignature(entry['extra_content'])
        calls.push({ id, name: fn['name'] as string, arguments: args, signature })
    }
    return calls.length > 0 ? calls : undefined
}

// OpenRouter relays Gemini's thoughtSignature here. Returns undefined for the
// common (non-Gemini-via-OpenRouter) case.
function extractThoughtSignature(extraContent: unknown): string | undefined {
    if (!isPlainObject(extraContent)) return undefined
    const google = extraContent['google']
    if (!isPlainObject(google)) return undefined
    const sig = google['thought_signature']
    return typeof sig === 'string' ? sig : undefined
}

function parseChatStreamDelta(
    raw: unknown,
    includeReasoningOutput = true,
): AdapterChatStreamDelta | null {
    if (!isPlainObject(raw)) return null
    const choices = raw['choices']
    let textDelta = ''
    let reasoningDelta = ''
    let finishReason: string | undefined
    if (Array.isArray(choices) && choices.length > 0 && isPlainObject(choices[0])) {
        const first = choices[0] as Record<string, unknown>
        const delta = first['delta']
        if (isPlainObject(delta)) {
            if (typeof delta['content'] === 'string') {
                textDelta = delta['content'] as string
            }
            // OpenRouter streams reasoning as `reasoning`, DeepSeek-style servers as
            // `reasoning_content`. Keep it separate from the visible answer.
            if (includeReasoningOutput && typeof delta['reasoning'] === 'string') {
                reasoningDelta = delta['reasoning'] as string
            } else if (
                includeReasoningOutput
                && typeof delta['reasoning_content'] === 'string'
            ) {
                reasoningDelta = delta['reasoning_content'] as string
            }
        }
        if (typeof first['finish_reason'] === 'string') {
            finishReason = first['finish_reason'] as string
        }
    }
    const usage = parseUsage(raw['usage'])
    if (textDelta.length === 0 && reasoningDelta.length === 0 && finishReason === undefined && usage === undefined) {
        return null
    }
    return { textDelta, reasoningDelta: reasoningDelta.length > 0 ? reasoningDelta : undefined, finishReason, usage, raw }
}

function resolveReasoningOutputOptions(preset: ModelPreset): ReasoningOutputOptions {
    const enabled = hasPresetFlag(preset, 'deepSeekThinkingOutput')
    const isDeepSeekProfile = preset.profileSnapshot.providerBaseId === 'deepseek'
        || (
            !isCustomPreset(preset)
            && preset.profileSnapshot.schema.some(
                (field) => field.key === 'customFlag_deepSeekThinkingOutput',
            )
        )
        || hasCustomModelIdToken(preset, 'deepseek')
    return {
        includeNative: !isDeepSeekProfile || enabled,
        thinkTagFallback: enabled,
    }
}

function applyThinkTagStreamFallback(
    delta: AdapterChatStreamDelta,
    parser: ThinkTagStreamParser,
): AdapterChatStreamDelta | null {
    if (delta.textDelta.length === 0) return delta
    const fallback = parser.push(delta.textDelta)
    const reasoningDelta = [delta.reasoningDelta, fallback.reasoning]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join('')
    if (
        fallback.text.length === 0
        && reasoningDelta.length === 0
        && delta.finishReason === undefined
        && delta.usage === undefined
    ) {
        return null
    }
    return {
        ...delta,
        textDelta: fallback.text,
        reasoningDelta: reasoningDelta.length > 0 ? reasoningDelta : undefined,
    }
}

function parseUsage(raw: unknown): AdapterUsage | undefined {
    if (!isPlainObject(raw)) return undefined
    const usage: AdapterUsage = {}
    if (typeof raw['prompt_tokens'] === 'number') usage.promptTokens = raw['prompt_tokens'] as number
    if (typeof raw['completion_tokens'] === 'number') {
        usage.completionTokens = raw['completion_tokens'] as number
    }
    if (typeof raw['total_tokens'] === 'number') usage.totalTokens = raw['total_tokens'] as number
    if (
        usage.promptTokens === undefined
        && usage.completionTokens === undefined
        && usage.totalTokens === undefined
    ) {
        return undefined
    }
    return usage
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

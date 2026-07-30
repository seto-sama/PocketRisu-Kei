import type { ModelPreset } from '../types'
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
import {
    applyOpenAiApiModeEndpoint,
    normalizeOpenAiResponsesBodyForMode,
} from './openaiApiMode'
import {
    applyBedrockAuthentication,
    resolveBedrockRegion,
} from './amazonBedrock'

type WireInputItem = Record<string, unknown>
type OpenAiImageDetail = 'auto' | 'low' | 'high'

export async function sendResponsesRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = await prepareResponsesBody(preset, options, credential, false)
    const raw = await sendPreparedJsonRequest(
        prepared,
        options,
        'Failed to parse OpenAI Responses JSON response',
    )
    return parseResponse(raw)
}

export async function* streamResponsesRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareResponsesBody(preset, options, credential, true)
    const stream = await openPreparedEventStream(
        prepared,
        options,
        'OpenAI Responses stream has no body',
    )

    try {
        for await (const event of parseSseStream(stream)) {
            if (!event.data || event.data === '[DONE]') continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (err) {
                throw new ModelPresetAdapterError('parse', 'Failed to parse OpenAI Responses stream event', { cause: err })
            }
            const delta = parseStreamEvent(raw)
            if (delta) yield delta
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

export function previewResponsesRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterPreparedRequest> {
    return prepareResponsesBody(preset, options, credential, false)
}

async function prepareResponsesBody(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
    stream: boolean,
): Promise<AdapterPreparedRequest> {
    const prepared = await prepareAdapterRequest({ preset, credential, abortSignal: options.abortSignal })
    applyOpenAiApiModeEndpoint(preset, prepared)
    normalizeOpenAiResponsesBodyForMode(preset, prepared.body)
    const modelId = resolveWireModelId(preset, { vendorName: 'OpenAI Responses' })
    const supportsPromptCacheBreakpoints = modelId.startsWith('gpt-5.6')
    const imageDetail = resolveImageDetail(preset)
    prepared.body.model = modelId
    prepared.body.input = options.messages.flatMap(
        (message) => toInputItems(message, supportsPromptCacheBreakpoints, imageDetail),
    )
    prepared.body.stream = stream
    if (!supportsPromptCacheBreakpoints) delete prepared.body.prompt_cache_options

    if (options.structuredOutput) {
        const text = isPlainObject(prepared.body.text) ? { ...prepared.body.text } : {}
        text.format = {
            type: 'json_schema',
            name: 'format',
            strict: options.structuredOutput.strict,
            schema: options.structuredOutput.schema,
        }
        prepared.body.text = text
    } else if (isPlainObject(prepared.body.text)) {
        const text = { ...prepared.body.text }
        delete text.format
        if (Object.keys(text).length > 0) prepared.body.text = text
        else delete prepared.body.text
    }

    if (options.tools?.length) {
        prepared.body.tools = options.tools.map(toWireTool)
    } else {
        delete prepared.body.tools
        delete prepared.body.tool_choice
        delete prepared.body.parallel_tool_calls
    }
    // These belong to Chat Completions and are invalid on /v1/responses.
    delete prepared.body.messages
    delete prepared.body.max_completion_tokens
    delete prepared.body.response_format
    if (preset.profileSnapshot.endpoint.kind === 'amazon-bedrock-mantle') {
        return applyBedrockAuthentication(prepared, credential, resolveBedrockRegion(preset))
    }
    return prepared
}

function toWireTool(tool: AdapterToolDef): WireInputItem {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    }
}

function toInputItems(
    message: AdapterChatMessage,
    supportsPromptCacheBreakpoints = false,
    imageDetail: OpenAiImageDetail = 'auto',
): WireInputItem[] {
    if (message.role === 'assistant' && Array.isArray(message.providerEcho)) {
        return message.providerEcho.filter(isPlainObject)
    }
    if (message.role === 'tool') {
        return [{
            type: 'function_call_output',
            call_id: message.toolCallId ?? '',
            output: message.content,
        }]
    }

    const items: WireInputItem[] = []
    if (message.content || !message.toolCalls?.length) {
        const content = message.role === 'user'
            ? toUserContent(
                message.content,
                message.images ?? [],
                message.cachePoint && supportsPromptCacheBreakpoints,
                imageDetail,
            )
            : [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }]
        if (message.role === 'system' && message.cachePoint && supportsPromptCacheBreakpoints && content.length > 0) {
            content[content.length - 1].prompt_cache_breakpoint = { mode: 'explicit' }
        }
        const item: WireInputItem = { role: message.role, content }
        if (message.role === 'assistant') {
            item.type = 'message'
            item.status = 'completed'
        }
        items.push(item)
    }
    for (const call of message.toolCalls ?? []) {
        items.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
            status: 'completed',
        })
    }
    return items
}

function toUserContent(
    text: string,
    images: AdapterImagePart[],
    cachePoint = false,
    imageDetail: OpenAiImageDetail = 'auto',
): WireInputItem[] {
    const content: WireInputItem[] = []
    if (text) content.push({ type: 'input_text', text })
    for (const image of images) {
        content.push({ type: 'input_image', detail: imageDetail, image_url: toDataUrl(image) })
    }
    if (cachePoint && content.length > 0) {
        content[content.length - 1].prompt_cache_breakpoint = { mode: 'explicit' }
    }
    return content
}

function resolveImageDetail(preset: ModelPreset): OpenAiImageDetail {
    if (preset.profileSnapshot.profileId !== 'openai-responses:official') return 'auto'
    const value = preset.gptVisionQuality
    return value === 'low' || value === 'high' ? value : 'auto'
}

function toDataUrl(image: AdapterImagePart): string {
    return `data:${image.mime ?? 'image/png'};base64,${image.base64}`
}

function parseResponse(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw)) throw new ModelPresetAdapterError('parse', 'OpenAI Responses response is not an object')
    const output = raw.output
    if (!Array.isArray(output)) throw new ModelPresetAdapterError('parse', 'OpenAI Responses response has no output array')

    let text = ''
    const toolCalls: AdapterToolCall[] = []
    const reasoning: AdapterReasoningPart[] = []
    for (const item of output) {
        if (!isPlainObject(item)) continue
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
                if (isPlainObject(part) && part.type === 'output_text' && typeof part.text === 'string') text += part.text
            }
        } else if (item.type === 'function_call' && typeof item.name === 'string') {
            toolCalls.push({
                id: typeof item.call_id === 'string' ? item.call_id : '',
                name: item.name,
                arguments: typeof item.arguments === 'string' ? item.arguments : '',
            })
        } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
            const summary = item.summary
                .filter(isPlainObject)
                .map((part) => typeof part.text === 'string' ? part.text : '')
                .join('')
            if (summary) reasoning.push({ text: summary })
        }
    }
    return {
        text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        reasoning: reasoning.length ? reasoning : undefined,
        providerEcho: output,
        finishReason: typeof raw.status === 'string' ? raw.status : undefined,
        usage: parseUsage(raw.usage),
        raw,
    }
}

function parseStreamEvent(raw: unknown): AdapterChatStreamDelta | null {
    if (!isPlainObject(raw) || typeof raw.type !== 'string') return null
    if (raw.type === 'response.output_text.delta' && typeof raw.delta === 'string') {
        return { textDelta: raw.delta, raw }
    }
    if (raw.type === 'response.reasoning_summary_text.delta' && typeof raw.delta === 'string') {
        return { textDelta: '', reasoningDelta: raw.delta, raw }
    }
    if (raw.type === 'response.completed' && isPlainObject(raw.response)) {
        return {
            textDelta: '',
            finishReason: typeof raw.response.status === 'string' ? raw.response.status : 'completed',
            usage: parseUsage(raw.response.usage),
            raw,
        }
    }
    if (raw.type === 'error' || raw.type === 'response.failed') {
        const error = raw.type === 'response.failed' && isPlainObject(raw.response)
            ? raw.response.error
            : raw.error
        const message = isPlainObject(error) && typeof error.message === 'string'
            ? error.message
            : 'OpenAI Responses stream failed'
        throw new ModelPresetAdapterError('unknown', message)
    }
    return null
}

function parseUsage(raw: unknown): AdapterUsage | undefined {
    if (!isPlainObject(raw)) return undefined
    const usage: AdapterUsage = {}
    if (typeof raw.input_tokens === 'number') usage.promptTokens = raw.input_tokens
    if (typeof raw.output_tokens === 'number') usage.completionTokens = raw.output_tokens
    if (typeof raw.total_tokens === 'number') usage.totalTokens = raw.total_tokens
    const details = raw.input_tokens_details
    if (isPlainObject(details) && typeof details.cached_tokens === 'number') usage.cachedTokens = details.cached_tokens
    return Object.keys(usage).length ? usage : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import type { ModelPreset } from '../types'
import {
    ModelPresetAdapterError,
    normalizeFetchError,
} from './error'
import {
    deriveAdapterHttpError,
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
    AdapterPreparedRequest,
    AdapterReasoningPart,
    AdapterToolCall,
    AdapterToolDef,
    AdapterUsage,
} from './types'
import { resolveWireModelId } from './wireInvariants'
import { isCustomPreset } from './customPreset'
import { resolveThinkingBudget } from './thinkingBudget'

// `anthropic` base provider v2+ supplies `max_tokens: 4096` via `defaultBody`,
// so freshly-resolved snapshots already carry the value. But presets persisted
// under an older snapshot (v1, `defaults: {}`) won't pick up the new default
// until they are re-resolved against the registry — and the profile version
// did not change (only the base provider did), so the profile-update detection
// will not flag them. Keep an adapter-side safety net for stale snapshots so
// existing chats keep working. `=== undefined` preserves any explicit 0 or
// negative override.
const ANTHROPIC_FALLBACK_MAX_TOKENS = 4096
const ANTHROPIC_PROVIDER_ID = 'anthropic'
const ANTHROPIC_BATCH_POLL_MS = 3_000
const ANTHROPIC_BATCH_TIMEOUT_MS = 24 * 60 * 60 * 1_000 + 10 * 60 * 1_000

type AnthropicContentBlock =
    | { type: 'text'; text: string; cache_control?: AnthropicCacheControl }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: AnthropicCacheControl }
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'redacted_thinking'; data: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown; cache_control?: AnthropicCacheControl }
    | { type: 'tool_result'; tool_use_id: string; content: string; cache_control?: AnthropicCacheControl }

interface AnthropicCacheControl {
    type: 'ephemeral'
    ttl?: '1h'
}

interface AnthropicWireMessage {
    role: 'user' | 'assistant'
    content: AnthropicContentBlock[]
}

interface AnthropicWireTool {
    name: string
    description?: string
    input_schema: unknown
}

export async function sendAnthropicChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = await prepareAnthropicBody(preset, options, credential, false)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (isAnthropicBatchingEnabled(preset)) {
        return sendAnthropicBatch(prepared, options, fetchImpl)
    }
    const raw = await sendPreparedJsonRequest(
        prepared,
        options,
        'Failed to parse Anthropic JSON response',
    )

    return parseAnthropicMessage(raw)
}

export async function* streamAnthropicChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareAnthropicBody(preset, options, credential, true)
    const stream = await openPreparedEventStream(
        prepared,
        options,
        'Anthropic stream response has no body',
    )

    try {
        for await (const event of parseSseStream(stream)) {
            if (event.event === 'ping') continue
            if (event.event === 'message_stop') return
            if (event.event === 'error') {
                throw deriveStreamError(event.data)
            }
            if (event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (err) {
                throw new ModelPresetAdapterError(
                    'parse',
                    'Failed to parse Anthropic stream chunk JSON',
                    { cause: err },
                )
            }
            const delta = parseAnthropicStreamDelta(event.event, raw)
            if (delta) yield delta
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

// Build the request without sending it (previewBody).
export function previewAnthropicChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterPreparedRequest> {
    return prepareAnthropicBody(preset, options, credential, false)
}

async function prepareAnthropicBody(
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
    // Wire invariants overwrite any customBody collisions (plan §4-5):
    //   - messages / system  → adapter owns the prompt structure
    //   - model              → adapter selects the wire model id
    //   - stream             → adapter controls the transport mode
    const modelId = resolveWireModelId(preset, { vendorName: 'Anthropic' })
    const { system, systemCachePoint, chat } = collectSystemAndChat(options.messages)
    const hasDirectCachePoint = systemCachePoint || chat.some((message) => message.cachePoint)
    const directCacheControl = resolveDirectCacheControl(preset, hasDirectCachePoint)
    const wireMessages = toAnthropicWireMessages(chat, directCacheControl)
    prepared.body.messages = wireMessages
    if (system.length > 0) {
        prepared.body.system = directCacheControl && systemCachePoint
            ? [{ type: 'text', text: system, cache_control: directCacheControl }]
            : system
    } else {
        delete prepared.body.system
    }
    if (options.tools && options.tools.length > 0) {
        prepared.body.tools = options.tools.map(toAnthropicTool)
    } else {
        // Tools are gated by the request, not customBody / additionalParams:
        // strip the whole tool-control surface when off so the OFF toggle is a
        // hard text-only gate (a lingering tool_choice would 400).
        delete prepared.body.tools
        delete prepared.body.tool_choice
    }
    prepared.body.model = modelId
    if (prepared.body.max_tokens === undefined) {
        prepared.body.max_tokens = ANTHROPIC_FALLBACK_MAX_TOKENS
    }
    if (!isCustomPreset(preset)) {
        applyAnthropicThinking(prepared.body, preset, modelId)
    }
    if (options.structuredOutput) {
        const outputConfig = isPlainObject(prepared.body.output_config)
            ? { ...prepared.body.output_config }
            : {}
        outputConfig.format = {
            type: 'json_schema',
            schema: options.structuredOutput.schema,
        }
        prepared.body.output_config = outputConfig
    } else if (isPlainObject(prepared.body.output_config)) {
        const outputConfig = { ...prepared.body.output_config }
        delete outputConfig.format
        if (Object.keys(outputConfig).length > 0) prepared.body.output_config = outputConfig
        else delete prepared.body.output_config
    }
    if (directCacheControl?.ttl === '1h') {
        appendAnthropicBeta(prepared.headers, 'extended-cache-ttl-2025-04-11')
    }
    prepared.body.stream = stream
    return prepared
}

function applyAnthropicThinking(
    body: Record<string, unknown>,
    preset: ModelPreset,
    modelId: string,
): void {
    const budget = resolveThinkingBudget(preset, 'effort')
    if (budget !== undefined) {
        body.thinking = { type: 'enabled', budget_tokens: budget }
        if (!isPlainObject(body.output_config)) return
        const outputConfig = { ...body.output_config }
        delete outputConfig.effort
        if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig
        else delete body.output_config
        return
    }

    const effort = isPlainObject(body.output_config)
        ? body.output_config.effort
        : undefined
    if (
        typeof effort === 'string'
        && effort.length > 0
        && supportsAdaptiveThinking(modelId)
    ) {
        body.thinking = { type: 'adaptive' }
    }
}

function supportsAdaptiveThinking(modelId: string): boolean {
    const normalized = modelId.toLowerCase()
    if (normalized.includes('claude-mythos-preview')) return true

    const claude4 = normalized.match(/claude-(?:opus|sonnet)-4[.-](\d+)(?:[.-]|$)/u)
    if (claude4 && Number(claude4[1]) >= 6) return true

    const later = normalized.match(
        /claude-(?:opus|sonnet|fable|mythos)-(\d+)(?:[.-]|$)/u,
    )
    return later !== null && Number(later[1]) >= 5
}

function toAnthropicTool(tool: AdapterToolDef): AnthropicWireTool {
    return { name: tool.name, description: tool.description, input_schema: tool.parameters }
}

function resolveDirectCacheControl(
    preset: ModelPreset,
    hasCachePoint: boolean,
): AnthropicCacheControl | undefined {
    if (preset.profileSnapshot.providerBaseId !== ANTHROPIC_PROVIDER_ID || !hasCachePoint) {
        return undefined
    }
    return preset.claude1HourCaching
        ? { type: 'ephemeral', ttl: '1h' }
        : { type: 'ephemeral' }
}

function isAnthropicBatchingEnabled(preset: ModelPreset): boolean {
    return preset.profileSnapshot.providerBaseId === ANTHROPIC_PROVIDER_ID
        && preset.claudeBatching === true
}

function appendAnthropicBeta(headers: Record<string, string>, beta: string): void {
    const key = Object.keys(headers).find((header) => header.toLowerCase() === 'anthropic-beta')
        ?? 'anthropic-beta'
    const values = (headers[key] ?? '').split(',').map((value) => value.trim()).filter(Boolean)
    if (!values.includes(beta)) values.push(beta)
    headers[key] = values.join(',')
}

function collectSystemAndChat(messages: AdapterChatMessage[]): {
    system: string
    systemCachePoint: boolean
    chat: AdapterChatMessage[]
} {
    const systems: string[] = []
    const chat: AdapterChatMessage[] = []
    let systemCachePoint = false
    for (const message of messages) {
        if (message.role === 'system') {
            systems.push(message.content)
            if (message.cachePoint) systemCachePoint = true
        } else {
            // tool / user / assistant are all carried into the wire builder,
            // which groups tool results onto a user turn (Anthropic shape).
            chat.push(message)
        }
    }
    return { system: systems.join('\n\n'), systemCachePoint, chat }
}

// Build the Anthropic message array. Consecutive tool-role messages are merged
// into ONE user message carrying multiple `tool_result` blocks (Anthropic
// requires every tool_use to be answered in the immediately following user
// turn). Assistant turns emit thinking blocks first, then text, then tool_use —
// the order Anthropic requires when thinking is enabled.
function toAnthropicWireMessages(
    chat: AdapterChatMessage[],
    cacheControl?: AnthropicCacheControl,
): AnthropicWireMessage[] {
    const out: AnthropicWireMessage[] = []
    let pendingToolResults: AnthropicContentBlock[] = []
    let pendingToolCachePoint = false

    const flushToolResults = () => {
        if (pendingToolResults.length > 0) {
            if (cacheControl && pendingToolCachePoint) {
                addCacheBoundary(pendingToolResults, cacheControl)
            }
            out.push({ role: 'user', content: pendingToolResults })
            pendingToolResults = []
            pendingToolCachePoint = false
        }
    }

    for (const message of chat) {
        if (message.role === 'tool') {
            pendingToolResults.push({
                type: 'tool_result',
                tool_use_id: message.toolCallId ?? '',
                content: message.content,
            })
            if (message.cachePoint) pendingToolCachePoint = true
            continue
        }
        flushToolResults()
        if (message.role === 'assistant') {
            // Verbatim re-send of the model's own turn (thinking signatures intact)
            // when captured this request; reconstruct for history-restored turns.
            const content = Array.isArray(message.providerEcho)
                ? (message.providerEcho as AnthropicContentBlock[]).map((block) => ({ ...block }))
                : toAssistantBlocks(message)
            if (cacheControl && message.cachePoint) addCacheBoundary(content, cacheControl)
            out.push({ role: 'assistant', content })
        } else {
            const content = toUserBlocks(message)
            if (cacheControl && message.cachePoint) addCacheBoundary(content, cacheControl)
            out.push({ role: 'user', content })
        }
    }
    flushToolResults()
    return out
}

function addCacheBoundary(
    content: AnthropicContentBlock[],
    cacheControl: AnthropicCacheControl,
): void {
    for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i]
        if (block.type === 'thinking' || block.type === 'redacted_thinking') continue
        content[i] = { ...block, cache_control: cacheControl }
        return
    }
}

// A user turn: the text block (always present, even empty, so a pure-image turn
// still carries the field) followed by one image block per attachment. Anthropic
// wants the raw base64 + media_type split out of the data URL.
function toUserBlocks(message: AdapterChatMessage): AnthropicContentBlock[] {
    const blocks: AnthropicContentBlock[] = [{ type: 'text', text: message.content }]
    for (const img of message.images ?? []) {
        blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mime ?? 'image/png', data: img.base64 },
        })
    }
    return blocks
}

function toAssistantBlocks(message: AdapterChatMessage): AnthropicContentBlock[] {
    const blocks: AnthropicContentBlock[] = []
    for (const part of message.reasoning ?? []) {
        if (part.redactedData !== undefined) {
            blocks.push({ type: 'redacted_thinking', data: part.redactedData })
        } else if (part.text !== undefined) {
            blocks.push({ type: 'thinking', thinking: part.text, signature: part.signature })
        }
    }
    if (message.content.length > 0) {
        blocks.push({ type: 'text', text: message.content })
    }
    for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseToolArgs(call.arguments) })
    }
    // Anthropic rejects an assistant message with an empty content array.
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
    return blocks
}

function parseToolArgs(args: string): unknown {
    if (!args) return {}
    try {
        return JSON.parse(args)
    } catch {
        return {}
    }
}

async function sendAnthropicBatch(
    prepared: AdapterPreparedRequest,
    options: AdapterChatOptions,
    fetchImpl: typeof fetch,
): Promise<AdapterChatResponse> {
    const collectionUrl = toBatchCollectionUrl(prepared.url)
    const customId = `pocketrisu-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const params = { ...prepared.body }
    delete params.stream
    let batchId: string | undefined

    try {
        const createResponse = await fetchImpl(collectionUrl, {
            method: 'POST',
            headers: prepared.headers,
            body: JSON.stringify({
                requests: [{ custom_id: customId, params }],
            }),
            signal: options.abortSignal,
        })
        if (!createResponse.ok) throw await deriveAdapterHttpError(createResponse)

        const deferredUsageJobId = createResponse.headers.get('x-risu-generation-job-id')
            ?? undefined
        const created = await readJsonObject(createResponse, 'Anthropic batch creation response')
        if (typeof created.id !== 'string' || created.id.length === 0) {
            throw new ModelPresetAdapterError('parse', 'Anthropic batch response has no id')
        }
        batchId = created.id
        const batchUrl = `${collectionUrl}/${encodeURIComponent(batchId)}`
        const startedAt = Date.now()
        let status = typeof created.processing_status === 'string'
            ? created.processing_status
            : undefined

        while (status !== 'ended') {
            if (Date.now() - startedAt > ANTHROPIC_BATCH_TIMEOUT_MS) {
                throw new ModelPresetAdapterError('timeout', 'Anthropic batch request timed out after 24 hours', {
                    retryable: true,
                    fallbackEligible: true,
                })
            }
            await abortableDelay(ANTHROPIC_BATCH_POLL_MS, options.abortSignal)
            const statusResponse = await fetchImpl(batchUrl, {
                method: 'GET',
                headers: prepared.headers,
                signal: options.abortSignal,
            })
            if (!statusResponse.ok) throw await deriveAdapterHttpError(statusResponse)
            const statusBody = await readJsonObject(statusResponse, 'Anthropic batch status response')
            status = typeof statusBody.processing_status === 'string'
                ? statusBody.processing_status
                : undefined
        }

        const resultsResponse = await fetchImpl(`${batchUrl}/results`, {
            method: 'GET',
            headers: prepared.headers,
            signal: options.abortSignal,
        })
        if (!resultsResponse.ok) throw await deriveAdapterHttpError(resultsResponse)
        const resultText = await resultsResponse.text()
        const result = parseBatchResult(resultText, customId)
        if (result.type !== 'succeeded') {
            const message = extractBatchFailureMessage(result)
            throw new ModelPresetAdapterError('server', message)
        }
        return {
            ...parseAnthropicMessage(result.message),
            deferredUsageJobId,
        }
    } catch (err) {
        if (batchId && options.abortSignal?.aborted) {
            try {
                await fetchImpl(`${collectionUrl}/${encodeURIComponent(batchId)}/cancel`, {
                    method: 'POST',
                    headers: prepared.headers,
                    body: '{}',
                })
            } catch {
                // Best effort: preserve the original abort error.
            }
        }
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

function toBatchCollectionUrl(messagesUrl: string): string {
    const withoutTrailingSlash = messagesUrl.replace(/\/+$/, '')
    return `${withoutTrailingSlash}/batches`
}

async function readJsonObject(response: Response, label: string): Promise<Record<string, unknown>> {
    let raw: unknown
    try {
        raw = await response.json()
    } catch (err) {
        throw new ModelPresetAdapterError('parse', `${label} is not valid JSON`, { cause: err })
    }
    if (!isPlainObject(raw)) {
        throw new ModelPresetAdapterError('parse', `${label} is not an object`)
    }
    return raw
}

function parseBatchResult(text: string, customId: string): Record<string, unknown> {
    for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue
        let entry: unknown
        try {
            entry = JSON.parse(line)
        } catch {
            continue
        }
        if (!isPlainObject(entry) || entry.custom_id !== customId || !isPlainObject(entry.result)) {
            continue
        }
        return entry.result
    }
    throw new ModelPresetAdapterError('parse', 'Anthropic batch results contain no matching request')
}

function extractBatchFailureMessage(result: Record<string, unknown>): string {
    const error = result.error
    if (isPlainObject(error)) {
        if (typeof error.message === 'string') return error.message
        if (isPlainObject(error.error) && typeof error.error.message === 'string') {
            return error.error.message
        }
    }
    const type = typeof result.type === 'string' ? result.type : 'failed'
    return `Anthropic batch request ${type}`
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timeout)
            reject(new DOMException('The operation was aborted', 'AbortError'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

function deriveStreamError(data: string): ModelPresetAdapterError {
    let message = 'Anthropic stream error'
    try {
        const parsed = JSON.parse(data) as { error?: { message?: unknown; type?: unknown } }
        if (typeof parsed?.error?.message === 'string') message = parsed.error.message
    } catch {
        // fall through with default message
    }
    return new ModelPresetAdapterError('server', message)
}

export function parseAnthropicMessage(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw)) {
        throw new ModelPresetAdapterError('parse', 'Anthropic response is not an object')
    }
    const content = raw['content']
    let text = ''
    const toolCalls: AdapterToolCall[] = []
    const reasoning: AdapterReasoningPart[] = []
    if (Array.isArray(content)) {
        for (const block of content) {
            if (!isPlainObject(block)) continue
            const type = block['type']
            if (type === 'text' && typeof block['text'] === 'string') {
                text += block['text'] as string
            } else if (type === 'tool_use' && typeof block['name'] === 'string') {
                toolCalls.push({
                    id: typeof block['id'] === 'string' ? (block['id'] as string) : '',
                    name: block['name'] as string,
                    arguments: JSON.stringify(block['input'] ?? {}),
                })
            } else if (type === 'thinking' && typeof block['thinking'] === 'string') {
                reasoning.push({
                    text: block['thinking'] as string,
                    signature: typeof block['signature'] === 'string' ? (block['signature'] as string) : undefined,
                })
            } else if (type === 'redacted_thinking' && typeof block['data'] === 'string') {
                reasoning.push({ redactedData: block['data'] as string })
            }
        }
    }
    const finishReason = typeof raw['stop_reason'] === 'string'
        ? (raw['stop_reason'] as string)
        : undefined
    return {
        text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        reasoning: reasoning.length > 0 ? reasoning : undefined,
        // Keep the raw content blocks so a tool follow-up resends the assistant
        // turn verbatim (thinking signatures must come back byte-for-byte).
        providerEcho: Array.isArray(content) ? content : undefined,
        finishReason,
        usage: parseAnthropicUsage(raw['usage']),
        raw,
    }
}

export function parseAnthropicStreamDelta(eventName: string | undefined, raw: unknown): AdapterChatStreamDelta | null {
    if (!isPlainObject(raw)) return null
    if (eventName === 'content_block_delta') {
        const delta = raw['delta']
        if (isPlainObject(delta) && delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            return { textDelta: delta['text'] as string, raw }
        }
        // thinking_delta carries the model's reasoning — keep it separate so it is
        // displayed as <Thoughts>, not concatenated into the visible answer.
        if (isPlainObject(delta) && delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
            return { textDelta: '', reasoningDelta: delta['thinking'] as string, raw }
        }
        return null
    }
    if (eventName === 'message_delta') {
        const delta = raw['delta']
        const finishReason = isPlainObject(delta) && typeof delta['stop_reason'] === 'string'
            ? (delta['stop_reason'] as string)
            : undefined
        const usage = parseAnthropicUsage(raw['usage'])
        if (finishReason === undefined && usage === undefined) return null
        return { textDelta: '', finishReason, usage, raw }
    }
    return null
}

function parseAnthropicUsage(raw: unknown): AdapterUsage | undefined {
    if (!isPlainObject(raw)) return undefined
    const usage: AdapterUsage = {}
    if (typeof raw['input_tokens'] === 'number') usage.promptTokens = raw['input_tokens'] as number
    if (typeof raw['output_tokens'] === 'number') usage.completionTokens = raw['output_tokens'] as number
    if (
        usage.promptTokens === undefined
        && usage.completionTokens === undefined
    ) {
        return undefined
    }
    if (usage.promptTokens !== undefined && usage.completionTokens !== undefined) {
        usage.totalTokens = usage.promptTokens + usage.completionTokens
    }
    return usage
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

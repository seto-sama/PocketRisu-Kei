import { Sha256 } from '@aws-crypto/sha256-js'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import type { ModelPreset } from '../types'
import {
    BEDROCK_CUSTOM_PATH_REGION,
    buildBedrockConverseEndpointUrl,
} from './bedrockEndpoint'
import {
    ModelPresetAdapterError,
    extractErrorMessage,
    normalizeFetchError,
    normalizeHttpStatus,
} from './error'
import { prepareAdapterRequest } from './resolveCredential'
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

interface BedrockIamCredential {
    kind: 'iam'
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
}

interface BedrockApiKeyCredential {
    kind: 'api-key'
    apiKey: string
}

export type ParsedBedrockCredential = BedrockIamCredential | BedrockApiKeyCredential

type BedrockContentBlock =
    | { text: string }
    | { image: { format: string; source: { bytes: string } } }
    | { toolUse: { toolUseId: string; name: string; input: unknown } }
    | { toolResult: { toolUseId: string; content: Array<{ text: string }> } }
    | { reasoningContent: { reasoningText: { text: string; signature?: string } } }
    | { reasoningContent: { redactedContent: string } }

interface BedrockWireMessage {
    role: 'user' | 'assistant'
    content: BedrockContentBlock[]
}

export async function sendAmazonBedrockChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = await prepareAmazonBedrockBody(preset, options, credential, false)
    const response = await fetchBedrock(prepared, options)
    let raw: unknown
    try {
        raw = await response.json()
    } catch (err) {
        throw new ModelPresetAdapterError('parse', 'Failed to parse Amazon Bedrock JSON response', {
            cause: err,
        })
    }
    return parseAmazonBedrockResponse(raw)
}

export async function* streamAmazonBedrockChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareAmazonBedrockBody(preset, options, credential, true)
    const response = await fetchBedrock(prepared, options)
    if (!response.body) {
        throw new ModelPresetAdapterError('parse', 'Amazon Bedrock stream response has no body')
    }

    try {
        for await (const message of parseAwsEventStream(response.body)) {
            const messageType = message.headers[':message-type']
            if (messageType === 'exception' || messageType === 'error') {
                throw bedrockStreamError(message)
            }
            const eventType = message.headers[':event-type']
            const raw = parseEventJson(message.payload)
            const delta = parseAmazonBedrockStreamEvent(eventType, raw)
            if (delta) yield delta
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

export function previewAmazonBedrockChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterPreparedRequest> {
    return prepareAmazonBedrockBody(preset, options, credential, false)
}

async function prepareAmazonBedrockBody(
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
    const region = resolveBedrockRegion(preset)
    prepared.url = buildBedrockConverseEndpointUrl(
        region,
        preset.profileSnapshot.modelId,
        stream,
    )

    const { system, chat } = collectSystemAndChat(options.messages)
    prepared.body.messages = toBedrockMessages(chat)
    if (system.length > 0) prepared.body.system = [{ text: system }]
    else delete prepared.body.system

    if (options.tools && options.tools.length > 0) {
        prepared.body.toolConfig = {
            tools: options.tools.map(toBedrockTool),
        }
    } else {
        delete prepared.body.toolConfig
    }

    delete prepared.body.model
    delete prepared.body.stream
    prepared.headers['Content-Type'] = 'application/json'
    prepared.headers.Accept = stream
        ? 'application/vnd.amazon.eventstream'
        : 'application/json'
    return applyBedrockAuthentication(prepared, credential, region)
}

async function fetchBedrock(
    prepared: AdapterPreparedRequest,
    options: AdapterChatOptions,
): Promise<Response> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
        response = await fetchImpl(prepared.url, {
            method: prepared.method,
            headers: prepared.headers,
            body: JSON.stringify(prepared.body),
            signal: options.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }
    if (!response.ok) throw await deriveHttpError(response)
    return response
}

export function parseBedrockCredential(value: string | undefined): ParsedBedrockCredential {
    const trimmed = value?.trim()
    if (!trimmed) throw authError('Amazon Bedrock credential is required')
    if (!trimmed.startsWith('{')) return { kind: 'api-key', apiKey: trimmed }

    let raw: unknown
    try {
        raw = JSON.parse(trimmed)
    } catch (cause) {
        throw new ModelPresetAdapterError(
            'auth',
            'Amazon Bedrock AWS credentials JSON is malformed',
            { retryable: false, fallbackEligible: false, cause },
        )
    }
    if (!isPlainObject(raw)) throw authError('Amazon Bedrock AWS credentials must be a JSON object')
    const accessKeyId = pickString(raw, 'accessKeyId', 'aws_access_key_id', 'AWS_ACCESS_KEY_ID')
    const secretAccessKey = pickString(
        raw,
        'secretAccessKey',
        'aws_secret_access_key',
        'AWS_SECRET_ACCESS_KEY',
    )
    const sessionToken = pickString(raw, 'sessionToken', 'aws_session_token', 'AWS_SESSION_TOKEN')
    if (!accessKeyId || !secretAccessKey) {
        throw authError(
            'Amazon Bedrock AWS credentials JSON requires accessKeyId and secretAccessKey',
        )
    }
    return {
        kind: 'iam',
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
    }
}

export async function applyBedrockAuthentication(
    prepared: AdapterPreparedRequest,
    credential: AdapterCredential | undefined,
    region: string,
): Promise<AdapterPreparedRequest> {
    const parsed = parseBedrockCredential(credential?.apiKey)
    if (parsed.kind === 'api-key') {
        return {
            ...prepared,
            headers: setHeader(prepared.headers, 'Authorization', `Bearer ${parsed.apiKey}`),
        }
    }

    const url = new URL(prepared.url)
    const body = JSON.stringify(prepared.body)
    const headers = setHeader(prepared.headers, 'Host', url.host)
    const request = new HttpRequest({
        method: prepared.method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        headers,
        body,
    })
    const signer = new SignatureV4({
        sha256: Sha256,
        credentials: {
            accessKeyId: parsed.accessKeyId,
            secretAccessKey: parsed.secretAccessKey,
            sessionToken: parsed.sessionToken,
        },
        region,
        service: 'bedrock',
    })
    const signed = await signer.sign(request)
    const outgoing: Record<string, string> = {}
    for (const [key, value] of Object.entries(signed.headers)) {
        // `Host` is part of the signature, but browsers set this forbidden
        // header themselves. Sending it explicitly would make direct fetch fail.
        if (key.toLowerCase() !== 'host') outgoing[key] = value
    }
    return { ...prepared, headers: outgoing }
}

export function resolveBedrockRegion(preset: ModelPreset): string {
    for (const field of preset.profileSnapshot.schema) {
        if (field.mapsTo?.target !== 'custom') continue
        if (field.mapsTo.path !== BEDROCK_CUSTOM_PATH_REGION) continue
        const value = preset.userValues[field.key] ?? field.default
        if (typeof value === 'string') return value
    }
    return 'us-east-1'
}

function collectSystemAndChat(messages: AdapterChatMessage[]): {
    system: string
    chat: AdapterChatMessage[]
} {
    const systems: string[] = []
    const chat: AdapterChatMessage[] = []
    for (const message of messages) {
        if (message.role === 'system') systems.push(message.content)
        else chat.push(message)
    }
    return { system: systems.join('\n\n'), chat }
}

function toBedrockMessages(messages: AdapterChatMessage[]): BedrockWireMessage[] {
    const result: BedrockWireMessage[] = []
    for (const message of messages) {
        if (message.role === 'tool') {
            appendMessage(result, {
                role: 'user',
                content: [{
                    toolResult: {
                        toolUseId: message.toolCallId ?? '',
                        content: [{ text: message.content }],
                    },
                }],
            })
            continue
        }

        const role = message.role === 'assistant' ? 'assistant' : 'user'
        const echoed = role === 'assistant' && Array.isArray(message.providerEcho)
            ? structuredClone(message.providerEcho) as BedrockContentBlock[]
            : undefined
        const content = echoed ?? toBedrockContent(message)
        appendMessage(result, { role, content })
    }
    return result
}

function appendMessage(messages: BedrockWireMessage[], next: BedrockWireMessage): void {
    const previous = messages.at(-1)
    if (previous?.role === next.role) {
        previous.content.push(...next.content)
    } else {
        messages.push(next)
    }
}

function toBedrockContent(message: AdapterChatMessage): BedrockContentBlock[] {
    const content: BedrockContentBlock[] = []
    for (const reasoning of message.reasoning ?? []) {
        if (reasoning.redactedData) {
            content.push({ reasoningContent: { redactedContent: reasoning.redactedData } })
        } else if (reasoning.text) {
            content.push({
                reasoningContent: {
                    reasoningText: {
                        text: reasoning.text,
                        ...(reasoning.signature ? { signature: reasoning.signature } : {}),
                    },
                },
            })
        }
    }
    if (message.content.length > 0 || content.length === 0) {
        content.push({ text: message.content })
    }
    if (message.role === 'user') {
        for (const image of message.images ?? []) content.push(toBedrockImage(image))
    }
    for (const call of message.toolCalls ?? []) {
        content.push({
            toolUse: {
                toolUseId: call.id,
                name: call.name,
                input: parseToolArguments(call.arguments),
            },
        })
    }
    return content
}

function toBedrockImage(image: AdapterImagePart): BedrockContentBlock {
    const formats: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpeg',
        'image/jpg': 'jpeg',
        'image/gif': 'gif',
        'image/webp': 'webp',
    }
    const format = formats[image.mime ?? 'image/png']
    if (!format) {
        throw new ModelPresetAdapterError(
            'invalid-request',
            `Amazon Bedrock does not support image type '${image.mime}'`,
            { retryable: false },
        )
    }
    return { image: { format, source: { bytes: image.base64 } } }
}

function toBedrockTool(tool: AdapterToolDef): Record<string, unknown> {
    return {
        toolSpec: {
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: { json: tool.parameters },
        },
    }
}

function parseToolArguments(value: string): unknown {
    try {
        return JSON.parse(value)
    } catch {
        return {}
    }
}

export function parseAmazonBedrockResponse(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw)) throw parseError('Amazon Bedrock response is not an object')
    const output = isPlainObject(raw.output) ? raw.output : undefined
    const message = output && isPlainObject(output.message) ? output.message : undefined
    const content = message?.content
    if (!Array.isArray(content)) throw parseError('Amazon Bedrock response has no output message')

    const text: string[] = []
    const toolCalls: AdapterToolCall[] = []
    const reasoning: AdapterReasoningPart[] = []
    for (const block of content) {
        if (!isPlainObject(block)) continue
        if (typeof block.text === 'string') text.push(block.text)
        if (isPlainObject(block.toolUse)) {
            const id = block.toolUse.toolUseId
            const name = block.toolUse.name
            if (typeof id === 'string' && typeof name === 'string') {
                toolCalls.push({
                    id,
                    name,
                    arguments: JSON.stringify(block.toolUse.input ?? {}),
                })
            }
        }
        if (isPlainObject(block.reasoningContent)) {
            const reasoningText = block.reasoningContent.reasoningText
            if (isPlainObject(reasoningText) && typeof reasoningText.text === 'string') {
                reasoning.push({
                    text: reasoningText.text,
                    signature: typeof reasoningText.signature === 'string'
                        ? reasoningText.signature
                        : undefined,
                })
            } else if (typeof block.reasoningContent.redactedContent === 'string') {
                reasoning.push({ redactedData: block.reasoningContent.redactedContent })
            }
        }
    }

    return {
        text: text.join(''),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        reasoning: reasoning.length > 0 ? reasoning : undefined,
        providerEcho: structuredClone(content),
        finishReason: typeof raw.stopReason === 'string' ? raw.stopReason : undefined,
        usage: parseUsage(raw.usage),
        raw,
    }
}

export function parseAmazonBedrockStreamEvent(
    eventType: string | undefined,
    raw: unknown,
): AdapterChatStreamDelta | undefined {
    if (!isPlainObject(raw)) return undefined
    if (eventType === 'contentBlockDelta' && isPlainObject(raw.delta)) {
        const reasoningContent = isPlainObject(raw.delta.reasoningContent)
            ? raw.delta.reasoningContent
            : undefined
        return {
            textDelta: typeof raw.delta.text === 'string' ? raw.delta.text : '',
            reasoningDelta: typeof reasoningContent?.text === 'string'
                ? reasoningContent.text
                : undefined,
            raw,
        }
    }
    if (eventType === 'messageStop') {
        return {
            textDelta: '',
            finishReason: typeof raw.stopReason === 'string' ? raw.stopReason : undefined,
            raw,
        }
    }
    if (eventType === 'metadata') {
        return { textDelta: '', usage: parseUsage(raw.usage), raw }
    }
    return undefined
}

export interface AwsEventMessage {
    headers: Record<string, string>
    payload: Uint8Array
}

export async function* parseAwsEventStream(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<AwsEventMessage, void, void> {
    const reader = stream.getReader()
    let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (value?.length) buffered = concatBytes(buffered, value)

            while (buffered.length >= 12) {
                const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength)
                const totalLength = view.getUint32(0, false)
                const headersLength = view.getUint32(4, false)
                if (totalLength < 16 || headersLength > totalLength - 16) {
                    throw parseError('Amazon Bedrock event stream frame is malformed')
                }
                if (buffered.length < totalLength) break

                const frame = buffered.slice(0, totalLength)
                buffered = buffered.slice(totalLength)
                const headers = parseEventHeaders(frame.slice(12, 12 + headersLength))
                const payload = frame.slice(12 + headersLength, totalLength - 4)
                yield { headers, payload }
            }
            if (done) break
        }
        if (buffered.length > 0) {
            throw parseError('Amazon Bedrock event stream ended with an incomplete frame')
        }
    } finally {
        reader.releaseLock()
    }
}

function parseEventHeaders(bytes: Uint8Array): Record<string, string> {
    const headers: Record<string, string> = {}
    const decoder = new TextDecoder()
    let offset = 0
    while (offset < bytes.length) {
        const nameLength = bytes[offset++]
        if (offset + nameLength + 1 > bytes.length) throw parseError('Invalid event header')
        const name = decoder.decode(bytes.slice(offset, offset + nameLength))
        offset += nameLength
        const type = bytes[offset++]
        if (type === 7) {
            if (offset + 2 > bytes.length) throw parseError('Invalid string event header')
            const length = (bytes[offset] << 8) | bytes[offset + 1]
            offset += 2
            if (offset + length > bytes.length) throw parseError('Invalid string event header')
            headers[name] = decoder.decode(bytes.slice(offset, offset + length))
            offset += length
        } else if (type === 0 || type === 1) {
            headers[name] = type === 0 ? 'true' : 'false'
        } else {
            offset = skipEventHeaderValue(bytes, offset, type)
        }
    }
    return headers
}

function skipEventHeaderValue(bytes: Uint8Array, offset: number, type: number): number {
    const fixed: Record<number, number> = { 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }
    if (type === 6) {
        if (offset + 2 > bytes.length) throw parseError('Invalid event header value')
        const length = (bytes[offset] << 8) | bytes[offset + 1]
        offset += 2 + length
    } else {
        const length = fixed[type]
        if (length === undefined) throw parseError(`Unsupported event header type '${type}'`)
        offset += length
    }
    if (offset > bytes.length) throw parseError('Invalid event header value')
    return offset
}

function parseEventJson(payload: Uint8Array): unknown {
    if (payload.length === 0) return {}
    try {
        return JSON.parse(new TextDecoder().decode(payload))
    } catch (cause) {
        throw new ModelPresetAdapterError(
            'parse',
            'Failed to parse Amazon Bedrock stream event JSON',
            { cause },
        )
    }
}

function bedrockStreamError(message: AwsEventMessage): ModelPresetAdapterError {
    const raw = parseEventJson(message.payload)
    const fallback = message.headers[':exception-type']
        ?? message.headers[':error-code']
        ?? 'Amazon Bedrock stream error'
    return new ModelPresetAdapterError('server', messageFromPayload(raw, fallback))
}

async function deriveHttpError(response: Response): Promise<ModelPresetAdapterError> {
    let payload: unknown
    let bodyText = ''
    try {
        bodyText = await response.text()
        payload = bodyText ? JSON.parse(bodyText) : undefined
    } catch {
        payload = bodyText
    }
    const normalized = normalizeHttpStatus(response.status)
    return new ModelPresetAdapterError(
        normalized.kind,
        messageFromPayload(payload, `Amazon Bedrock request failed (${response.status})`),
        {
            status: response.status,
            retryable: normalized.retryable,
            fallbackEligible: normalized.fallbackEligible,
        },
    )
}

function messageFromPayload(payload: unknown, fallback: string): string {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '')
    return extractErrorMessage(text) ?? fallback
}

function parseUsage(value: unknown): AdapterUsage | undefined {
    if (!isPlainObject(value)) return undefined
    const usage: AdapterUsage = {
        promptTokens: finite(value.inputTokens),
        completionTokens: finite(value.outputTokens),
        totalTokens: finite(value.totalTokens),
    }
    return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined
}

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pickString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = source[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
}

function setHeader(
    headers: Record<string, string>,
    name: string,
    value: string,
): Record<string, string> {
    const next: Record<string, string> = {}
    for (const [key, existing] of Object.entries(headers)) {
        if (key.toLowerCase() !== name.toLowerCase()) next[key] = existing
    }
    next[name] = value
    return next
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
    const result = new Uint8Array(left.length + right.length)
    result.set(left)
    result.set(right, left.length)
    return result
}

function authError(message: string): ModelPresetAdapterError {
    return new ModelPresetAdapterError('auth', message, {
        retryable: false,
        fallbackEligible: false,
    })
}

function parseError(message: string): ModelPresetAdapterError {
    return new ModelPresetAdapterError('parse', message, {
        retryable: false,
    })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

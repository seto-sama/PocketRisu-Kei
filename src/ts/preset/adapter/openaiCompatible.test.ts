import { describe, expect, test } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { ModelPresetAdapterError } from './error'
import { sendChatRequest, streamChatRequest, previewChatRequest } from './openaiCompatible'
import type { AdapterChatMessage } from './types'

function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:standard',
        providerBaseId: 'demo',
        adapterKind: 'openai-compatible',
        auth: { kind: 'bearer', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
        modelId: 'demo-fast',
        schema: [
            {
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                default: 'demo-fast',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        headerTemplate: { 'Content-Type': 'application/json' },
        capabilities: ['streaming'],
        ...overrides,
    }
}

function makePreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset-1',
        name: 'Demo Preset',
        profileSnapshot: makeSnapshot(),
        userValues: {},
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    }
}

const userMessages: AdapterChatMessage[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
]

interface CapturedCall {
    url: string
    method: string
    headers: Record<string, string>
    body: Record<string, unknown>
    signal: AbortSignal | null | undefined
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
    })
}

function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(encoder.encode(chunks[i]))
                i++
            } else {
                controller.close()
            }
        },
    })
    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    })
}

function captureFetch(response: Response | (() => Response)): {
    fetchImpl: typeof fetch
    calls: CapturedCall[]
} {
    const calls: CapturedCall[] = []
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const headers = init?.headers as Record<string, string> | undefined
        const body = init?.body != null ? JSON.parse(init.body as string) : {}
        calls.push({
            url,
            method: (init?.method ?? 'GET') as string,
            headers: headers ?? {},
            body,
            signal: init?.signal,
        })
        return typeof response === 'function' ? response() : response
    }
    return { fetchImpl, calls }
}

describe('sendChatRequest (non-stream)', () => {
    test('builds OpenAI-compatible body and parses choices/usage', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                choices: [
                    {
                        message: { role: 'assistant', content: 'hi there' },
                        finish_reason: 'stop',
                    },
                ],
                usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
            }),
        )
        const result = await sendChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk-test' },
        )
        expect(result.text).toBe('hi there')
        expect(result.finishReason).toBe('stop')
        expect(result.usage).toEqual({ promptTokens: 9, completionTokens: 2, totalTokens: 11 })

        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://demo.test/v1/chat/completions')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].headers.Authorization).toBe('Bearer sk-test')
        expect(calls[0].headers['Content-Type']).toBe('application/json')
        expect(calls[0].body).toEqual({
            model: 'demo-fast',
            stream: false,
            messages: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hello' },
            ],
        })
    })

    test('customBody cannot override messages or stream', async () => {
        const preset = makePreset({
            customBody: {
                messages: [{ role: 'system', content: 'hijacked' }],
                stream: true,
                extra: 'kept',
            },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(calls[0].body.messages).toEqual([
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
        ])
        expect(calls[0].body.stream).toBe(false)
        expect(calls[0].body.extra).toBe('kept')
    })

    test('customBody.model cannot override the wire model id', async () => {
        // body.model is a wire invariant per plan §4-5. resolveWireModelId
        // reads modelId from userValues / schema / snapshot directly, so a
        // customBody key collision must lose.
        const preset = makePreset({
            userValues: { modelId: 'demo-fast' },
            customBody: { model: 'hijacked-model' },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(calls[0].body.model).toBe('demo-fast')
    })

    test('throws invalid-request when userValues.modelId is an empty string', async () => {
        // Explicit empty modelId is treated as a configuration error rather
        // than silently falling back to the schema default (otherwise
        // corrupted UI/migration data would call the wrong endpoint).
        const preset = makePreset({ userValues: { modelId: '' } })
        const { fetchImpl } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        )
        await expect(
            sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({ kind: 'invalid-request', retryable: false })
    })

    test('throws auth error on 401 with provider error message', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { message: 'invalid key', type: 'auth' } }, { status: 401 }),
        )
        await expect(
            sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({
            name: 'ModelPresetAdapterError',
            kind: 'auth',
            status: 401,
            retryable: false,
            fallbackEligible: false,
            message: 'invalid key',
        })
    })

    test('throws server error on 500 with parsed message', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { message: 'upstream down' } }, { status: 500 }),
        )
        await expect(
            sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({ kind: 'server', status: 500, fallbackEligible: true })
    })

    test('throws parse error when response is missing choices', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({ choices: [] }))
        await expect(
            sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({ kind: 'parse' })
    })

    test('passes through abort signal and normalizes AbortError', async () => {
        const controller = new AbortController()
        const abort = new Error('user cancelled')
        abort.name = 'AbortError'
        const fetchImpl: typeof fetch = async (_input, init) => {
            expect(init?.signal).toBe(controller.signal)
            throw abort
        }
        await expect(
            sendChatRequest(
                makePreset(),
                { messages: userMessages, fetchImpl, abortSignal: controller.signal },
                { apiKey: 'sk' },
            ),
        ).rejects.toMatchObject({ kind: 'aborted', retryable: false })
    })

    test('network errors are normalized to retryable network kind', async () => {
        const fetchImpl: typeof fetch = async () => {
            throw new TypeError('fetch failed')
        }
        await expect(
            sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' }),
        ).rejects.toMatchObject({ kind: 'network', retryable: true, fallbackEligible: true })
    })

    test('translates AdapterChatMessage fields to wire format (name, tool_call_id)', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            {
                messages: [
                    {
                        role: 'tool',
                        content: '{"result":42}',
                        name: 'calc',
                        toolCallId: 'call_1',
                    },
                ],
                fetchImpl,
            },
            { apiKey: 'sk' },
        )
        expect(calls[0].body.messages).toEqual([
            { role: 'tool', content: '{"result":42}', name: 'calc', tool_call_id: 'call_1' },
        ])
    })
})

describe('streamChatRequest', () => {
    test('yields textDelta chunks and stops at [DONE]', async () => {
        const { fetchImpl, calls } = captureFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
                'data: [DONE]\n\n',
            ]),
        )
        const deltas: string[] = []
        let lastFinish: string | undefined
        for await (const delta of streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )) {
            if (delta.textDelta) deltas.push(delta.textDelta)
            if (delta.finishReason) lastFinish = delta.finishReason
        }
        expect(deltas.join('')).toBe('Hello')
        expect(lastFinish).toBe('stop')
        expect(calls[0].body.stream).toBe(true)
        expect(calls[0].headers.Accept).toBe('text/event-stream')
    })

    test('routes reasoning / reasoning_content deltas to reasoningDelta, not textDelta', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"reasoning":"step "}}]}\n\n',
                'data: {"choices":[{"delta":{"reasoning_content":"two"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
                'data: [DONE]\n\n',
            ]),
        )
        const text: string[] = []
        const reasoning: string[] = []
        for await (const delta of streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )) {
            if (delta.textDelta) text.push(delta.textDelta)
            if (delta.reasoningDelta) reasoning.push(delta.reasoningDelta)
        }
        expect(text.join('')).toBe('answer')
        expect(reasoning.join('')).toBe('step two')
    })

    test('separates split think tags in a DeepSeek stream when output is enabled', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"content":"<th"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"ink>fallback "}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"reasoning</thi"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"nk>visible answer"}}]}\n\n',
                'data: [DONE]\n\n',
            ]),
        )
        const text: string[] = []
        const reasoning: string[] = []
        for await (const delta of streamChatRequest(
            makePreset({
                userValues: {
                    modelId: 'deepseek-chat',
                    customFlag_deepSeekThinkingOutput: true,
                },
            }),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )) {
            if (delta.textDelta) text.push(delta.textDelta)
            if (delta.reasoningDelta) reasoning.push(delta.reasoningDelta)
        }

        expect(text.join('')).toBe('visible answer')
        expect(reasoning.join('')).toBe('fallback reasoning')
    })

    test('captures usage emitted in the final chunk', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
                'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
                'data: [DONE]\n\n',
            ]),
        )
        let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined
        for await (const delta of streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )) {
            if (delta.usage) usage = delta.usage
        }
        expect(usage).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 })
    })

    test('requests usage in first-party OpenAI streams', async () => {
        const { fetchImpl, calls } = captureFetch(
            sseResponse(['data: [DONE]\n\n']),
        )
        const preset = makePreset({
            profileSnapshot: makeSnapshot({ providerBaseId: 'openai' }),
        })

        for await (const _delta of streamChatRequest(
            preset,
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )) {
            // Drain the stream so the request is made.
        }

        expect(calls[0].body.stream_options).toEqual({ include_usage: true })
    })

    test('throws parse error on non-JSON SSE data', async () => {
        const { fetchImpl } = captureFetch(sseResponse(['data: {not json}\n\n']))
        const gen = streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )
        await expect(gen.next()).rejects.toMatchObject({ kind: 'parse' })
    })

    test('classifies HTTP errors before streaming starts', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { message: 'limited' } }, { status: 429 }),
        )
        const gen = streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            kind: 'rate-limit',
            retryable: true,
            fallbackEligible: false,
        })
    })

    test('normalizes AbortError thrown during stream body read', async () => {
        const abort = new Error('user cancelled mid stream')
        abort.name = 'AbortError'
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'))
                controller.error(abort)
            },
        })
        const fetchImpl: typeof fetch = async () => new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        })
        const gen = streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )
        const collect = async () => {
            const out: string[] = []
            for await (const delta of gen) {
                if (delta.textDelta) out.push(delta.textDelta)
            }
            return out
        }
        await expect(collect()).rejects.toMatchObject({
            name: 'ModelPresetAdapterError',
            kind: 'aborted',
            retryable: false,
        })
    })

    test('normalizes network errors thrown during stream body read', async () => {
        const networkErr = new TypeError('connection reset')
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.error(networkErr)
            },
        })
        const fetchImpl: typeof fetch = async () => new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        })
        const gen = streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            name: 'ModelPresetAdapterError',
            kind: 'network',
            retryable: true,
            fallbackEligible: true,
        })
    })

    test('lets domain parse errors pass through the stream wrapper', async () => {
        const { fetchImpl } = captureFetch(sseResponse(['data: not-json\n\n']))
        const gen = streamChatRequest(
            makePreset(),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )
        await expect(gen.next()).rejects.toMatchObject({ kind: 'parse' })
    })
})

describe('error class identity', () => {
    test('thrown error is ModelPresetAdapterError instance', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({}, { status: 403 }))
        try {
            await sendChatRequest(
                makePreset(),
                { messages: userMessages, fetchImpl },
                { apiKey: 'sk' },
            )
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
        }
    })
})

describe('tool use (Stage 1)', () => {
    const toolDef = {
        name: 'search',
        description: 'web search',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
    }

    test('declares tools as function envelopes in the request body', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            { messages: userMessages, tools: [toolDef], fetchImpl },
            { apiKey: 'sk' },
        )
        expect(calls[0].body.tools).toEqual([
            {
                type: 'function',
                function: {
                    name: 'search',
                    description: 'web search',
                    parameters: { type: 'object', properties: { q: { type: 'string' } } },
                },
            },
        ])
    })

    test('serializes assistant toolCalls and tool results onto the wire', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'final' } }] }),
        )
        const convo: AdapterChatMessage[] = [
            { role: 'user', content: 'find x' },
            { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":"x"}' }] },
            { role: 'tool', content: 'result text', toolCallId: 'c1', name: 'search' },
        ]
        await sendChatRequest(
            makePreset(),
            { messages: convo, tools: [toolDef], fetchImpl },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[1]).toEqual({
            role: 'assistant',
            content: 'checking',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
        })
        expect(wire[2]).toEqual({ role: 'tool', content: 'result text', name: 'search', tool_call_id: 'c1' })
    })

    test('parses tool_calls (including parallel) from the response', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            { id: 'a', type: 'function', function: { name: 'alpha', arguments: '{"n":1}' } },
                            { id: 'b', type: 'function', function: { name: 'beta', arguments: '{}' } },
                        ],
                    },
                    finish_reason: 'tool_calls',
                }],
            }),
        )
        const result = await sendChatRequest(
            makePreset(),
            { messages: userMessages, tools: [toolDef], fetchImpl },
            { apiKey: 'sk' },
        )
        expect(result.toolCalls).toEqual([
            { id: 'a', name: 'alpha', arguments: '{"n":1}' },
            { id: 'b', name: 'beta', arguments: '{}' },
        ])
    })

    test('omits tools and tool-coupled fields on tool-less requests', async () => {
        const preset = makePreset({ customBody: { parallel_tool_calls: true, tool_choice: 'auto' } })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(calls[0].body.tools).toBeUndefined()
        expect(calls[0].body.parallel_tool_calls).toBeUndefined()
        expect(calls[0].body.tool_choice).toBeUndefined()
    })

    test('strips customBody.tools when the request carries no tools (off = hard gate)', async () => {
        const preset = makePreset({ customBody: { tools: [{ type: 'function', function: { name: 'sneaky' } }] } })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }),
        )
        await sendChatRequest(preset, { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(calls[0].body.tools).toBeUndefined()
    })

    test('resends an assistant turn verbatim via providerEcho (preserves reasoning_details)', async () => {
        const rawAssistant = {
            role: 'assistant',
            content: 'thinking out loud',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } }],
            reasoning_details: [{ type: 'reasoning.text', text: 'chain', id: 'r1' }],
        }
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: 'thinking out loud', toolCalls: [{ id: 't1', name: 'a', arguments: '{}' }], providerEcho: rawAssistant },
                    { role: 'tool', content: 'r', toolCallId: 't1', name: 'a' },
                ],
                tools: [toolDef],
                fetchImpl,
            },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[1]).toEqual(rawAssistant) // byte-for-byte, incl. reasoning_details
    })

    test('round-trips Gemini thought signature via extra_content (OpenRouter)', async () => {
        // Parse: signature lifted from extra_content.google.thought_signature.
        const { fetchImpl } = captureFetch(
            jsonResponse({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{
                            id: 'g1',
                            type: 'function',
                            function: { name: 'search', arguments: '{}' },
                            extra_content: { google: { thought_signature: 'SIG-XYZ' } },
                        }],
                    },
                }],
            }),
        )
        const result = await sendChatRequest(
            makePreset(),
            { messages: userMessages, tools: [toolDef], fetchImpl },
            { apiKey: 'sk' },
        )
        expect(result.toolCalls).toEqual([{ id: 'g1', name: 'search', arguments: '{}', signature: 'SIG-XYZ' }])

        // Serialize: signature written back to the same extension on the wire.
        const { fetchImpl: fetchImpl2, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: '', toolCalls: [{ id: 'g1', name: 'search', arguments: '{}', signature: 'SIG-XYZ' }] },
                    { role: 'tool', content: 'r', toolCallId: 'g1', name: 'search' },
                ],
                tools: [toolDef],
                fetchImpl: fetchImpl2,
            },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[1].tool_calls).toEqual([{
            id: 'g1',
            type: 'function',
            function: { name: 'search', arguments: '{}' },
            extra_content: { google: { thought_signature: 'SIG-XYZ' } },
        }])
    })
})

describe('vision (Stage 3)', () => {
    test('serializes a user image as a content-part array with text + image_url', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'what is this', images: [{ kind: 'image', base64: 'AAAA', mime: 'image/jpeg' }] },
                ],
                fetchImpl,
            },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[0]).toEqual({
            role: 'user',
            content: [
                { type: 'text', text: 'what is this' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
            ],
        })
    })

    test('a text-only user turn stays a plain string (no regression)', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[1]).toEqual({ role: 'user', content: 'Hello' })
    })

    test('maps the preset Vision Quality to image_url.detail', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await sendChatRequest(
            makePreset({
                profileSnapshot: makeSnapshot({
                    profileId: 'openai:official',
                    providerBaseId: 'openai',
                }),
                gptVisionQuality: 'high',
            }),
            {
                messages: [
                    { role: 'user', content: 'inspect', images: [{ kind: 'image', base64: 'HQ', mime: 'image/png' }] },
                ],
                fetchImpl,
            },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<{ content: Array<Record<string, any>> }>
        expect(wire[0].content[1].image_url).toEqual({
            url: 'data:image/png;base64,HQ',
            detail: 'high',
        })
    })

    test('defaults mime to image/png when omitted', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        )
        await sendChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: '', images: [{ kind: 'image', base64: 'ZZ' }] }], fetchImpl },
            { apiKey: 'sk' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[0].content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,ZZ' } }])
    })
})

describe('reasoning display (Stage 4a)', () => {
    test('parses the OpenRouter `reasoning` string into a reasoning part', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'answer', reasoning: 'because' } }] }),
        )
        const result = await sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(result.reasoning).toEqual([{ text: 'because' }])
    })

    test('falls back to `reasoning_content` (DeepSeek-style)', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'a', reasoning_content: 'step' } }] }),
        )
        const result = await sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(result.reasoning).toEqual([{ text: 'step' }])
    })

    test('gates DeepSeek reasoning output behind its per-preset flag', async () => {
        const response = () => jsonResponse({
            choices: [{
                message: {
                    content: 'answer',
                    reasoning_content: 'hidden reasoning',
                },
            }],
        })
        const deepSeekSnapshot = makeSnapshot({
            providerBaseId: 'deepseek',
            modelId: 'opaque-chat-model',
        })
        const disabled = makePreset({
            profileSnapshot: deepSeekSnapshot,
            userValues: { modelId: 'opaque-chat-model' },
        })
        const enabled = makePreset({
            profileSnapshot: deepSeekSnapshot,
            userValues: {
                modelId: 'opaque-chat-model',
                customFlag_deepSeekThinkingOutput: true,
            },
        })

        const off = await sendChatRequest(
            disabled,
            { messages: userMessages, fetchImpl: captureFetch(response).fetchImpl },
            { apiKey: 'sk' },
        )
        const on = await sendChatRequest(
            enabled,
            { messages: userMessages, fetchImpl: captureFetch(response).fetchImpl },
            { apiKey: 'sk' },
        )

        expect(off.reasoning).toBeUndefined()
        expect(on.reasoning).toEqual([{ text: 'hidden reasoning' }])
    })

    test('gates output for a DeepSeek-family profile served by another provider', async () => {
        const response = () => jsonResponse({
            choices: [{
                message: {
                    content: 'answer',
                    reasoning_content: 'hosted reasoning',
                },
            }],
        })
        const baseSnapshot = makeSnapshot()
        const hostedSnapshot = makeSnapshot({
            providerBaseId: 'ollama-cloud',
            modelId: 'opaque-hosted-model',
            schema: [
                ...baseSnapshot.schema,
                {
                    key: 'customFlag_deepSeekThinkingOutput',
                    type: 'boolean',
                    label: 'deepSeekThinkingOutput',
                    default: false,
                },
            ],
        })
        const off = await sendChatRequest(
            makePreset({ profileSnapshot: hostedSnapshot }),
            { messages: userMessages, fetchImpl: captureFetch(response).fetchImpl },
            { apiKey: 'sk' },
        )
        const on = await sendChatRequest(
            makePreset({
                profileSnapshot: hostedSnapshot,
                userValues: { customFlag_deepSeekThinkingOutput: true },
            }),
            { messages: userMessages, fetchImpl: captureFetch(response).fetchImpl },
            { apiKey: 'sk' },
        )

        expect(off.reasoning).toBeUndefined()
        expect(on.reasoning).toEqual([{ text: 'hosted reasoning' }])
    })

    test('uses think tags when enabled DeepSeek output has no native reasoning field', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                choices: [{
                    message: {
                        content: '<think>fallback reasoning</think>visible answer',
                    },
                }],
            }),
        )
        const result = await sendChatRequest(
            makePreset({
                userValues: {
                    modelId: 'deepseek-chat',
                    customFlag_deepSeekThinkingOutput: true,
                },
            }),
            { messages: userMessages, fetchImpl },
            { apiKey: 'sk' },
        )

        expect(result.reasoning).toEqual([{ text: 'fallback reasoning' }])
        expect(result.text).toBe('visible answer')
    })

    test('no reasoning field → undefined (non-reasoning models unchanged)', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ choices: [{ message: { content: 'a' } }] }),
        )
        const result = await sendChatRequest(makePreset(), { messages: userMessages, fetchImpl }, { apiKey: 'sk' })
        expect(result.reasoning).toBeUndefined()
    })
})

describe('previewChatRequest (no network)', () => {
    test('returns the prepared body without fetching', async () => {
        let fetched = false
        const fetchImpl: typeof fetch = async () => { fetched = true; return jsonResponse({}) }
        const prepared = await previewChatRequest(
            makePreset(),
            { messages: userMessages, tools: [{ name: 'a', parameters: { type: 'object' } }], fetchImpl },
            { apiKey: 'sk' },
        )
        expect(fetched).toBe(false)
        expect(prepared.url).toBe('https://demo.test/v1/chat/completions')
        expect((prepared.body.tools as unknown[]).length).toBe(1)
    })

    test('uses the Images API body and parses generated GPT Image data', async () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                providerBaseId: 'openai',
                endpoint: {
                    kind: 'static',
                    url: 'https://api.openai.com/v1/images/generations',
                },
                modelId: 'gpt-image-2',
                capabilities: ['image-output'],
            }),
            userValues: { modelId: 'gpt-image-2' },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ data: [{ b64_json: 'PNGDATA' }] }),
        )
        const response = await sendChatRequest(
            preset,
            {
                messages: [
                    { role: 'system', content: 'old context' },
                    { role: 'user', content: 'draw a cat' },
                ],
                fetchImpl,
            },
            { apiKey: 'sk' },
        )

        expect(calls[0].body).toEqual({
            model: 'gpt-image-2',
            prompt: 'draw a cat',
        })
        expect(response.media).toEqual([
            { kind: 'image', mime: 'image/png', base64: 'PNGDATA' },
        ])
    })

    test.each([
        ['moonshotai', 'opaque-chat-model', 'partial'],
        ['deepseek', 'opaque-chat-model', 'prefix'],
    ] as const)(
        'automatically applies the %s provider assistant-prefill extension for current profiles',
        async (providerBaseId, modelId, extension) => {
            const prepared = await previewChatRequest(
                makePreset({
                    profileSnapshot: makeSnapshot({ providerBaseId, modelId }),
                    userValues: { modelId },
                }),
                {
                    messages: [
                        { role: 'assistant', content: 'Earlier assistant turn' },
                        { role: 'user', content: 'Continue with this prefix' },
                        { role: 'assistant', content: 'Answer: ' },
                    ],
                },
                { apiKey: 'sk' },
            )
            const messages = prepared.body.messages as Array<Record<string, unknown>>

            expect(messages[0]).not.toHaveProperty(extension)
            expect(messages[2]).toMatchObject({
                role: 'assistant',
                content: 'Answer: ',
                [extension]: true,
            })
        },
    )

    test('uses DeepSeek beta endpoint for direct prefix completion', async () => {
        const prepared = await previewChatRequest(
            makePreset({
                profileSnapshot: makeSnapshot({
                    providerBaseId: 'deepseek',
                    endpoint: {
                        kind: 'static',
                        url: 'https://api.deepseek.com/chat/completions',
                    },
                }),
                userValues: { modelId: 'deepseek-chat' },
            }),
            {
                messages: [
                    { role: 'user', content: 'Continue this' },
                    { role: 'assistant', content: 'Answer: ' },
                ],
            },
            { apiKey: 'sk' },
        )

        expect(prepared.url).toBe('https://api.deepseek.com/beta/chat/completions')
    })

    test('sends saved reasoning_content only for an enabled final DeepSeek prefill', async () => {
        const prepared = await previewChatRequest(
            makePreset({
                profileSnapshot: makeSnapshot({
                    providerBaseId: 'deepseek',
                    modelId: 'opaque-chat-model',
                }),
                userValues: {
                    modelId: 'opaque-chat-model',
                    customFlag_deepSeekThinkingInput: true,
                },
            }),
            {
                messages: [
                    { role: 'assistant', content: 'Earlier', reasoning: [{ text: 'ignore me' }] },
                    { role: 'user', content: 'Continue' },
                    {
                        role: 'assistant',
                        content: 'Answer: ',
                        reasoning: [{ text: 'first thought' }, { text: 'second thought' }],
                    },
                ],
            },
            { apiKey: 'sk' },
        )
        const messages = prepared.body.messages as Array<Record<string, unknown>>

        expect(messages[0]).not.toHaveProperty('reasoning_content')
        expect(messages[2]).toMatchObject({
            prefix: true,
            reasoning_content: 'first thought\nsecond thought',
        })
    })

    test('keeps the ordinary DeepSeek endpoint when there is no assistant prefill', async () => {
        const prepared = await previewChatRequest(
            makePreset({
                profileSnapshot: makeSnapshot({
                    providerBaseId: 'deepseek',
                    endpoint: {
                        kind: 'static',
                        url: 'https://api.deepseek.com/chat/completions',
                    },
                }),
                userValues: { modelId: 'deepseek-chat' },
            }),
            { messages: [{ role: 'user', content: 'Normal request' }] },
            { apiKey: 'sk' },
        )

        expect(prepared.url).toBe('https://api.deepseek.com/chat/completions')
    })

    test('uses a regional Bedrock Mantle Chat Completions endpoint and bearer API key', async () => {
        const snapshot = makeSnapshot({
            profileId: 'amazon-bedrock:openai.gpt-5.6-sol',
            providerBaseId: 'amazon-bedrock--responses',
            auth: { kind: 'aws-bedrock', fields: ['bedrockCredential'] },
            endpoint: {
                kind: 'amazon-bedrock-mantle',
                path: 'openai/v1/responses',
            },
            modelId: 'openai.gpt-5.6-sol',
            schema: [
                {
                    key: 'bedrockCredential',
                    type: 'string',
                    label: 'Credential',
                    secret: true,
                    mapsTo: { target: 'auth', path: 'apiKey' },
                },
                {
                    key: 'bedrockRegion',
                    type: 'string',
                    label: 'AWS Region',
                    default: 'us-east-1',
                    mapsTo: { target: 'custom', path: 'bedrockRegion' },
                },
                {
                    key: 'openaiApiMode',
                    type: 'string',
                    label: 'OpenAI API',
                    default: 'completions',
                    mapsTo: { target: 'custom', path: 'openaiApiMode' },
                },
            ],
        })
        const prepared = await previewChatRequest(
            makePreset({
                profileSnapshot: snapshot,
                userValues: {
                    bedrockRegion: 'us-west-2',
                    openaiApiMode: 'completions',
                },
            }),
            { messages: [{ role: 'user', content: 'hello' }] },
            { apiKey: 'bedrock-api-key' },
        )

        expect(prepared.url)
            .toBe('https://bedrock-mantle.us-west-2.api.aws/openai/v1/chat/completions')
        expect(prepared.headers.Authorization).toBe('Bearer bedrock-api-key')
        expect(prepared.body.model).toBe('openai.gpt-5.6-sol')
    })
})

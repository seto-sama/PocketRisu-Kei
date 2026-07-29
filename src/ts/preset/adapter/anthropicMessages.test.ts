import { describe, expect, test } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { sendAnthropicChatRequest, streamAnthropicChatRequest } from './anthropicMessages'
import { ModelPresetAdapterError } from './error'
import type { AdapterChatMessage } from './types'

function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:anthropic',
        providerBaseId: 'anthropic',
        adapterKind: 'anthropic-messages',
        auth: { kind: 'x-api-key', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1/messages' },
        modelId: 'claude-demo',
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
                default: 'claude-demo',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        // Mirrors the `anthropic` base provider's defaultBody (registry v2).
        // `max_tokens` is required by the Messages API; supplied here as the
        // conservative default. Tests that exercise overrides set it via
        // `overrides.defaults` (which replaces this entire object).
        defaults: { max_tokens: 4096 },
        headerTemplate: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
        },
        capabilities: ['streaming'],
        ...overrides,
    }
}

function makePreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset-anthropic',
        name: 'Anthropic',
        profileSnapshot: makeSnapshot(),
        userValues: {},
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    }
}

const messagesWithSystem: AdapterChatMessage[] = [
    { role: 'system', content: 'You are kind.' },
    { role: 'user', content: 'Hi' },
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

describe('sendAnthropicChatRequest (non-stream)', () => {
    test('separates system messages, wraps content as text blocks, and sets x-api-key + anthropic-version', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                content: [{ type: 'text', text: 'hello' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 2 },
            }),
        )
        const result = await sendAnthropicChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'ant-test' },
        )
        expect(result.text).toBe('hello')
        expect(result.finishReason).toBe('end_turn')
        expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 })
        expect(calls[0].url).toBe('https://demo.test/v1/messages')
        expect(calls[0].headers['x-api-key']).toBe('ant-test')
        expect(calls[0].headers['anthropic-version']).toBe('2023-06-01')
        expect(calls[0].body).toMatchObject({
            model: 'claude-demo',
            stream: false,
            system: 'You are kind.',
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
            ],
        })
        expect(calls[0].body.max_tokens).toBe(4096)
    })

    test('maps Budget effort to Claude thinking tokens', async () => {
        const base = makeSnapshot()
        const value = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    ...base.schema,
                    {
                        key: 'effort',
                        type: 'string',
                        label: 'Reasoning Effort',
                        mapsTo: { target: 'body', path: 'output_config.effort' },
                    },
                    {
                        key: 'thinking_tokens',
                        type: 'integer',
                        label: 'Thinking Tokens',
                        default: 1024,
                    },
                ],
                capabilities: ['streaming', 'reasoning'],
            }),
            userValues: {
                modelId: 'claude-sonnet-4-6',
                effort: 'budget',
                thinking_tokens: 2048,
            },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )

        await sendAnthropicChatRequest(
            value,
            { messages: [{ role: 'user', content: 'Think' }], fetchImpl },
            { apiKey: 'key' },
        )

        expect(calls[0].body.thinking).toEqual({
            type: 'enabled',
            budget_tokens: 2048,
        })
        expect(calls[0].body).not.toHaveProperty('output_config.effort')
    })

    test('enables adaptive thinking with effort on Claude 4.6 and later', async () => {
        const base = makeSnapshot()
        const value = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    ...base.schema,
                    {
                        key: 'effort',
                        type: 'string',
                        label: 'Reasoning Effort',
                        mapsTo: { target: 'body', path: 'output_config.effort' },
                    },
                ],
                capabilities: ['streaming', 'reasoning'],
            }),
            userValues: {
                modelId: 'claude-sonnet-4-6',
                effort: 'medium',
            },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )

        await sendAnthropicChatRequest(
            value,
            { messages: [{ role: 'user', content: 'Think' }], fetchImpl },
            { apiKey: 'key' },
        )

        expect(calls[0].body.thinking).toEqual({ type: 'adaptive' })
        expect(calls[0].body.output_config).toMatchObject({ effort: 'medium' })
    })

    test('does not send adaptive thinking to Claude 4.5', async () => {
        const base = makeSnapshot()
        const value = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    ...base.schema,
                    {
                        key: 'effort',
                        type: 'string',
                        label: 'Reasoning Effort',
                        mapsTo: { target: 'body', path: 'output_config.effort' },
                    },
                ],
                capabilities: ['streaming', 'reasoning'],
            }),
            userValues: {
                modelId: 'claude-opus-4-5',
                effort: 'medium',
            },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )

        await sendAnthropicChatRequest(
            value,
            { messages: [{ role: 'user', content: 'Think' }], fetchImpl },
            { apiKey: 'key' },
        )

        expect(calls[0].body).not.toHaveProperty('thinking')
        expect(calls[0].body.output_config).toMatchObject({ effort: 'medium' })
    })

    test('joins multiple system messages with double newline', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'system', content: 'first system' },
                    { role: 'system', content: 'second system' },
                    { role: 'user', content: 'hi' },
                ],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        expect(calls[0].body.system).toBe('first system\n\nsecond system')
    })

    test('maps native cachePoint to a one-hour Anthropic cache boundary', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            makePreset({ claude1HourCaching: true }),
            {
                messages: [
                    { role: 'system', content: 'system' },
                    { role: 'user', content: 'cached prefix', cachePoint: true },
                    { role: 'assistant', content: 'prior answer' },
                    { role: 'user', content: 'new prompt' },
                ],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const messages = calls[0].body.messages as Array<{ content: Array<Record<string, unknown>> }>
        expect(messages[0].content.at(-1)?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
        expect(messages[1].content.at(-1)?.cache_control).toBeUndefined()
        expect(calls[0].headers['anthropic-beta']).toContain('extended-cache-ttl-2025-04-11')
    })

    test('uses the default five-minute cache boundary when one-hour caching is off', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            makePreset(),
            { messages: [{ role: 'system', content: 'cached system', cachePoint: true }, { role: 'user', content: 'hi' }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.system).toEqual([
            { type: 'text', text: 'cached system', cache_control: { type: 'ephemeral' } },
        ])
        expect(calls[0].headers['anthropic-beta']).toBeUndefined()
    })

    test('submits and parses an Anthropic Message Batch when enabled', async () => {
        let captured: ReturnType<typeof captureFetch>
        captured = captureFetch(() => {
            if (captured.calls.length === 1) {
                return new Response(JSON.stringify({ id: 'batch-1', processing_status: 'ended' }), {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                        'x-risu-generation-job-id': 'usage-job-1',
                    },
                })
            }
            const requests = captured.calls[0].body.requests as Array<{ custom_id: string }>
            return new Response(JSON.stringify({
                custom_id: requests[0].custom_id,
                result: {
                    type: 'succeeded',
                    message: {
                        content: [{ type: 'text', text: 'batched' }],
                        stop_reason: 'end_turn',
                        usage: { input_tokens: 4, output_tokens: 2 },
                    },
                },
            }) + '\n', { status: 200 })
        })

        const result = await sendAnthropicChatRequest(
            makePreset({ claudeBatching: true }),
            { messages: messagesWithSystem, fetchImpl: captured.fetchImpl },
            { apiKey: 'k' },
        )

        expect(result.text).toBe('batched')
        expect(result.usage).toEqual({ promptTokens: 4, completionTokens: 2, totalTokens: 6 })
        expect(result.deferredUsageJobId).toBe('usage-job-1')
        expect(captured.calls.map((call) => call.url)).toEqual([
            'https://demo.test/v1/messages/batches',
            'https://demo.test/v1/messages/batches/batch-1/results',
        ])
        const requests = captured.calls[0].body.requests as Array<{ params: Record<string, unknown> }>
        expect(requests[0].params.stream).toBeUndefined()
        expect(requests[0].params.messages).toBeDefined()
    })

    test('omits system field when no system messages present', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'plain' }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.system).toBeUndefined()
    })

    test('snapshot defaults.max_tokens overrides the registry-supplied default', async () => {
        // The base provider's defaultBody supplies max_tokens: 4096; a
        // per-profile or per-preset override (here via snapshot defaults)
        // should win.
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        const preset = makePreset({
            profileSnapshot: makeSnapshot({ defaults: { max_tokens: 200 } }),
        })
        await sendAnthropicChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.max_tokens).toBe(200)
    })

    test('stale v1 snapshots (empty defaults) get max_tokens from the adapter safety net', async () => {
        // Presets persisted before the `anthropic` base provider bumped to v2
        // still carry `defaults: {}`. The profile-update detection compares
        // profile version (not base-provider version), and we did not bump the
        // profile, so those snapshots will never get re-resolved automatically.
        // The adapter fallback keeps them working.
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        const preset = makePreset({
            profileSnapshot: makeSnapshot({ defaults: {} }),
        })
        await sendAnthropicChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.max_tokens).toBe(4096)
    })

    test('explicit zero max_tokens in defaults is preserved by the adapter (not clobbered by the safety net)', async () => {
        // The fallback guards on `=== undefined`, so any explicit value
        // (including 0 or a negative number) must survive. This protects
        // intentional overrides through customBody / userValues mapping that
        // happen to use a falsy number.
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        const preset = makePreset({
            profileSnapshot: makeSnapshot({ defaults: { max_tokens: 0 } }),
        })
        await sendAnthropicChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.max_tokens).toBe(0)
    })

    test('maps user/assistant roles to user/assistant', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q1' },
                    { role: 'assistant', content: 'a1' },
                ],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        expect(calls[0].body.messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'q1' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        ])
    })

    test('serializes tool turns: assistant tool_use + grouped tool_result on a user turn', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q1' },
                    { role: 'assistant', content: 'using tools', toolCalls: [
                        { id: 'call-1', name: 'a', arguments: '{"x":1}' },
                        { id: 'call-2', name: 'b', arguments: '{}' },
                    ] },
                    { role: 'tool', content: 'r1', toolCallId: 'call-1', name: 'a' },
                    { role: 'tool', content: 'r2', toolCallId: 'call-2', name: 'b' },
                ],
                tools: [{ name: 'a', description: 'A', parameters: { type: 'object' } }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const msgs = calls[0].body.messages as Array<Record<string, unknown>>
        expect(msgs[1]).toEqual({
            role: 'assistant',
            content: [
                { type: 'text', text: 'using tools' },
                { type: 'tool_use', id: 'call-1', name: 'a', input: { x: 1 } },
                { type: 'tool_use', id: 'call-2', name: 'b', input: {} },
            ],
        })
        // Both tool results collapse into ONE user turn.
        expect(msgs[2]).toEqual({
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'call-1', content: 'r1' },
                { type: 'tool_result', tool_use_id: 'call-2', content: 'r2' },
            ],
        })
        expect(calls[0].body.tools).toEqual([{ name: 'a', description: 'A', input_schema: { type: 'object' } }])
    })

    test('round-trips thinking blocks (with signature) ahead of tool_use', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    {
                        role: 'assistant',
                        content: '',
                        reasoning: [
                            { text: 'let me think', signature: 'sig-abc' },
                            { redactedData: 'REDACTED' },
                        ],
                        toolCalls: [{ id: 'c1', name: 'a', arguments: '{}' }],
                    },
                ],
                tools: [{ name: 'a', parameters: {} }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const msgs = calls[0].body.messages as Array<Record<string, unknown>>
        expect(msgs[1].content).toEqual([
            { type: 'thinking', thinking: 'let me think', signature: 'sig-abc' },
            { type: 'redacted_thinking', data: 'REDACTED' },
            { type: 'tool_use', id: 'c1', name: 'a', input: {} },
        ])
    })

    test('parses tool_use and thinking blocks from the response', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                content: [
                    { type: 'thinking', thinking: 'hmm', signature: 'S' },
                    { type: 'text', text: 'calling' },
                    { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'x' } },
                ],
                stop_reason: 'tool_use',
            }),
        )
        const result = await sendAnthropicChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'search', parameters: {} }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(result.text).toBe('calling')
        expect(result.toolCalls).toEqual([{ id: 'tu1', name: 'search', arguments: '{"q":"x"}' }])
        expect(result.reasoning).toEqual([{ text: 'hmm', signature: 'S' }])
    })

    test('strips customBody.tools/tool_choice when the request carries no tools (off = hard gate)', async () => {
        const preset = makePreset({ customBody: { tools: [{ name: 'sneaky', input_schema: {} }], tool_choice: { type: 'any' } } })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(preset, { messages: [{ role: 'user', content: 'q' }], fetchImpl }, { apiKey: 'k' })
        expect(calls[0].body.tools).toBeUndefined()
        expect(calls[0].body.tool_choice).toBeUndefined()
    })

    test('resends content blocks verbatim via providerEcho (preserves thinking signature)', async () => {
        const rawContent = [
            { type: 'thinking', thinking: 'deep', signature: 'SIG' },
            { type: 'text', text: 'answer' },
            { type: 'tool_use', id: 'tu1', name: 'a', input: {} },
        ]
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'done' }] }),
        )
        await sendAnthropicChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: 'answer', toolCalls: [{ id: 'tu1', name: 'a', arguments: '{}' }], providerEcho: rawContent },
                    { role: 'tool', content: 'r', toolCallId: 'tu1', name: 'a' },
                ],
                tools: [{ name: 'a', parameters: {} }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const msgs = calls[0].body.messages as Array<Record<string, unknown>>
        expect(msgs[1]).toEqual({ role: 'assistant', content: rawContent })
    })

    test('customBody cannot inject system field when user provided no system message', async () => {
        const preset = makePreset({
            customBody: { system: 'HIJACK', extra: 'kept' },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            preset,
            { messages: [{ role: 'user', content: 'hi' }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.system).toBeUndefined()
        expect(calls[0].body.extra).toBe('kept')
    })

    test('customBody.system cannot override user-provided system message', async () => {
        const preset = makePreset({
            customBody: { system: 'HIJACK' },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.system).toBe('You are kind.')
    })

    test('customBody.model cannot override the wire model id', async () => {
        const preset = makePreset({
            userValues: { modelId: 'claude-real' },
            customBody: { model: 'HIJACK' },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.model).toBe('claude-real')
    })

    test('concatenates multiple text blocks in response', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                content: [
                    { type: 'text', text: 'first ' },
                    { type: 'text', text: 'second' },
                ],
            }),
        )
        const result = await sendAnthropicChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(result.text).toBe('first second')
    })

    test('classifies HTTP 401 as auth non-retryable + non-eligible', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { type: 'authentication_error', message: 'bad key' } }, { status: 401 }),
        )
        await expect(
            sendAnthropicChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({
            kind: 'auth',
            status: 401,
            retryable: false,
            fallbackEligible: false,
            message: 'bad key',
        })
    })

    test('classifies HTTP 529 (anthropic overloaded) as server retryable + eligible', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { type: 'overloaded_error', message: 'busy' } }, { status: 529 }),
        )
        await expect(
            sendAnthropicChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({ kind: 'server', retryable: true, fallbackEligible: true })
    })
})

describe('streamAnthropicChatRequest', () => {
    test('yields text deltas from content_block_delta and stops at message_stop', async () => {
        const { fetchImpl, calls } = captureFetch(
            sseResponse([
                'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n',
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"He"}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}\n\n',
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ]),
        )
        const deltas: string[] = []
        let finishReason: string | undefined
        let usage: { completionTokens?: number } | undefined
        for await (const delta of streamAnthropicChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )) {
            if (delta.textDelta) deltas.push(delta.textDelta)
            if (delta.finishReason) finishReason = delta.finishReason
            if (delta.usage) usage = delta.usage
        }
        expect(deltas.join('')).toBe('Hello')
        expect(finishReason).toBe('end_turn')
        expect(usage).toMatchObject({ completionTokens: 5 })
        expect(calls[0].body.stream).toBe(true)
        expect(calls[0].headers.Accept).toBe('text/event-stream')
    })

    test('separates thinking_delta into reasoningDelta, never into textDelta', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step "}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"one"}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ]),
        )
        const text: string[] = []
        const reasoning: string[] = []
        for await (const delta of streamAnthropicChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )) {
            if (delta.textDelta) text.push(delta.textDelta)
            if (delta.reasoningDelta) reasoning.push(delta.reasoningDelta)
        }
        expect(text.join('')).toBe('answer')
        expect(reasoning.join('')).toBe('step one')
    })

    test('skips ping events and ignores message_start/content_block_start/stop noise', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'event: ping\ndata: {}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
                'event: ping\ndata: {}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ]),
        )
        const out: string[] = []
        for await (const delta of streamAnthropicChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )) {
            if (delta.textDelta) out.push(delta.textDelta)
        }
        expect(out).toEqual(['x'])
    })

    test('event:error in the SSE stream throws a server error with extracted message', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"slow"}}\n\n',
            ]),
        )
        const gen = streamAnthropicChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            name: 'ModelPresetAdapterError',
            kind: 'server',
            message: 'slow',
        })
    })

    test('normalizes AbortError thrown during stream body read', async () => {
        const abort = new Error('cancelled')
        abort.name = 'AbortError'
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new TextEncoder().encode(
                    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
                ))
                controller.error(abort)
            },
        })
        const fetchImpl: typeof fetch = async () => new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        })
        const gen = streamAnthropicChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        const collect = async () => {
            const out: string[] = []
            for await (const delta of gen) {
                if (delta.textDelta) out.push(delta.textDelta)
            }
            return out
        }
        await expect(collect()).rejects.toMatchObject({ kind: 'aborted', retryable: false })
    })
})

describe('error class identity', () => {
    test('thrown error is ModelPresetAdapterError instance', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({}, { status: 500 }))
        try {
            await sendAnthropicChatRequest(
                makePreset(),
                { messages: messagesWithSystem, fetchImpl },
                { apiKey: 'k' },
            )
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
        }
    })
})

describe('vision (Stage 3)', () => {
    test('appends an image block (raw base64 + media_type) to the user turn', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            makePreset(),
            {
                messages: [{ role: 'user', content: 'describe', images: [{ kind: 'image', base64: 'BBBB', mime: 'image/png' }] }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[0]).toEqual({
            role: 'user',
            content: [
                { type: 'text', text: 'describe' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
            ],
        })
    })

    test('a text-only user turn keeps a single text block (no regression)', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
        )
        await sendAnthropicChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'plain' }], fetchImpl },
            { apiKey: 'k' },
        )
        const wire = calls[0].body.messages as Array<Record<string, unknown>>
        expect(wire[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'plain' }] })
    })
})

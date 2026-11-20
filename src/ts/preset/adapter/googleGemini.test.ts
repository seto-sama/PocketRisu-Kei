import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { decodingFetch } from './__testDecodingFetch'
import { resetGeminiContextCacheRuntime } from '../cache/geminiContextCache'
import {
    resetGeminiCacheWiringRuntime,
    settleGeminiCacheTasks,
} from '../cache/geminiCacheWiring'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { sendGoogleChatRequest, streamGoogleChatRequest } from './googleGemini'
import { createThoughtSignatureCollector, restoreThoughtSignatures, type ThoughtSignatureContext } from './thoughtSignatures'
import { decodeAdapterResponseBody } from './responseDecoder'
import { createDecodedChatProjection } from './decodedEvents'
import { expandAdapterMessages, toAdapterMessage } from '../../process/request/modelPresetMessages'
import { formatPresetMessages } from '../../process/request/formatMessages'
import type { AdapterCacheContext, AdapterChatMessage } from './types'
import { compileModelPreset } from '../runtime/compilePreset'

// Minimal service-account fixture; server transport resolves signing credentials.
const VERTEX_SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'my-proj',
    private_key_id: 'kid-1',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIBVwIB...\n-----END PRIVATE KEY-----\n',
    client_email: 'svc@my-proj.iam.gserviceaccount.com',
    client_id: '1',
    token_uri: 'https://oauth2.googleapis.com/token',
})

function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:google',
        providerBaseId: 'google',
        adapterKind: 'google-gemini',
        auth: { kind: 'x-goog-api-key', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1beta/models' },
        modelId: 'gemini-demo',
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
                default: 'gemini-demo',
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
        id: 'preset-google',
        name: 'Gemini',
        profileSnapshot: makeSnapshot(),
        userValues: {},
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    }
}

const messagesWithSystem: AdapterChatMessage[] = [
    { role: 'system', content: 'You are factual.' },
    { role: 'user', content: 'Hi' },
]

interface CapturedCall {
    url: string
    method: string
    headers: Record<string, string>
    body: Record<string, unknown>
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
    const fetchImpl: typeof fetch = decodingFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const headers = init?.headers as Record<string, string> | undefined
        const body = init?.body != null ? JSON.parse(init.body as string) : {}
        calls.push({
            url,
            method: (init?.method ?? 'GET') as string,
            headers: headers ?? {},
            body,
        })
        return typeof response === 'function' ? response() : response
    })
    return { fetchImpl, calls }
}

async function sendCompiledGeminiRequest(
    promptMessages: Parameters<typeof formatPresetMessages>[0],
    db: Parameters<typeof formatPresetMessages>[2],
) {
    const preset = makePreset({ foldSystemPrompt: false, keepFirstSystemPrompt: false })
    const compiled = compileModelPreset(preset)
    const formatted = formatPresetMessages(structuredClone(promptMessages), compiled.behavior, db)
    const { fetchImpl, calls } = captureFetch(
        jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    )
    await sendGoogleChatRequest(
        preset,
        { messages: formatted.map(message => toAdapterMessage(message)), fetchImpl },
        { apiKey: 'k' },
    )
    return { body: calls[0].body, formatted }
}

describe('Gemini compiled system prompt formatting', () => {
    test.each([
        ['user', '', 'user', 'Late instruction.', 'Reminder: be concise.'],
        ['assistant', '', 'model', 'Late instruction.', 'Reminder: be concise.'],
        ['user', 'Instruction: {{slot}}', 'user', 'Instruction: Late instruction.', 'Instruction: Reminder: be concise.'],
    ] as const)(
        'keeps leading systems native for replacement role %s with template %s',
        async (systemRoleReplacement, systemContentReplacement, expectedRole, lateInstruction, reminder) => {
            const { body, formatted } = await sendCompiledGeminiRequest([
                { role: 'system', content: 'Be helpful.' },
                { role: 'system', content: 'Follow the safety rules.', cachePoint: true },
                { role: 'user', content: 'Question?' },
                { role: 'assistant', content: 'Earlier answer.' },
                { role: 'system', content: 'Late instruction.' },
                { role: 'system', content: 'Reminder: be concise.' },
            ], { systemRoleReplacement, systemContentReplacement })

            expect(formatted[0].cachePoint).toBe(true)
            expect(body.systemInstruction).toEqual({
                parts: [{ text: 'Be helpful.\n\nFollow the safety rules.' }],
            })
            expect(body.contents).toEqual([
                { role: 'user', parts: [{ text: 'Question?' }] },
                { role: 'model', parts: [{ text: 'Earlier answer.' }] },
                { role: expectedRole, parts: [{ text: lateInstruction }] },
                { role: expectedRole, parts: [{ text: reminder }] },
            ])
        },
    )

    test('omits systemInstruction when there is no leading system', async () => {
        const { body } = await sendCompiledGeminiRequest([
            { role: 'user', content: 'Question?' },
            { role: 'system', content: 'Late instruction.' },
        ], { systemRoleReplacement: 'assistant', systemContentReplacement: '' })

        expect(body.systemInstruction).toBeUndefined()
        expect(body.contents).toEqual([
            { role: 'user', parts: [{ text: 'Question?' }] },
            { role: 'model', parts: [{ text: 'Late instruction.' }] },
        ])
    })
})

describe('sendGoogleChatRequest (non-stream)', () => {
    test('embeds modelId in URL path, uses x-goog-api-key, and sends contents + systemInstruction', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                candidates: [
                    {
                        content: { parts: [{ text: 'hello' }], role: 'model' },
                        finishReason: 'STOP',
                    },
                ],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
            }),
        )
        const result = await sendGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'goog-test' },
        )
        expect(result.text).toBe('hello')
        expect(result.finishReason).toBe('STOP')
        expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 })

        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini-demo:generateContent')
        expect(calls[0].headers['x-goog-api-key']).toBe('goog-test')
        expect(calls[0].body.model).toBeUndefined() // moved into URL path
        expect(calls[0].body.contents).toEqual([
            { role: 'user', parts: [{ text: 'Hi' }] },
        ])
        expect(calls[0].body.systemInstruction).toEqual({
            parts: [{ text: 'You are factual.' }],
        })
    })

    test('always requests thought summaries when Gemini thinking is enabled', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        const value = makePreset({
            profileSnapshot: makeSnapshot({
                bodyTemplate: {
                    generationConfig: {
                        thinkingConfig: { thinkingLevel: 'high' },
                    },
                },
            }),
        })

        await sendGoogleChatRequest(
            value,
            { messages: [{ role: 'user', content: 'x' }], fetchImpl },
            { apiKey: 'k' },
        )

        expect(calls[0].body.generationConfig).toEqual({
            thinkingConfig: {
                thinkingLevel: 'high',
                includeThoughts: true,
            },
        })
    })

    test('maps assistant role to model and merges multi-part text in candidate content', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                candidates: [
                    {
                        content: {
                            parts: [{ text: 'a ' }, { text: 'b' }],
                            role: 'model',
                        },
                    },
                ],
            }),
        )
        const result = await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: 'r' },
                    { role: 'user', content: 'q2' },
                ],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        expect(result.text).toBe('a b')
        expect(calls[0].body.contents).toEqual([
            { role: 'user', parts: [{ text: 'q' }] },
            { role: 'model', parts: [{ text: 'r' }] },
            { role: 'user', parts: [{ text: 'q2' }] },
        ])
    })

    test('serializes tool turns: functionCall on model, grouped functionResponse on user', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: '', toolCalls: [
                        { id: 'c1', name: 'a', arguments: '{"x":1}', signature: 'sig-1' },
                        { id: 'c2', name: 'b', arguments: '{}' },
                    ] },
                    { role: 'tool', content: 'r1', toolCallId: 'c1', name: 'a' },
                    { role: 'tool', content: 'r2', toolCallId: 'c2', name: 'b' },
                ],
                tools: [{ name: 'a', description: 'A', parameters: { type: 'object' } }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        // The first model functionCall keeps its thought signature.
        expect(contents[1]).toEqual({
            role: 'model',
            parts: [
                { functionCall: { id: 'c1', name: 'a', args: { x: 1 } }, thoughtSignature: 'sig-1' },
                { functionCall: { id: 'c2', name: 'b', args: {} } },
            ],
        })
        // Both tool results share a user turn and echo their call IDs.
        expect(contents[2]).toEqual({
            role: 'user',
            parts: [
                { functionResponse: { id: 'c1', name: 'a', response: { result: 'r1' } } },
                { functionResponse: { id: 'c2', name: 'b', response: { result: 'r2' } } },
            ],
        })
        expect(calls[0].body.tools).toEqual([
            { functionDeclarations: [{ name: 'a', description: 'A', parameters: { type: 'object' } }] },
        ])
    })

    test('parses functionCall (with thoughtSignature) and thought parts from response', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                candidates: [{
                    content: {
                        parts: [
                            { text: 'reasoning', thought: true, thoughtSignature: 'TS' },
                            { text: 'visible' },
                            { functionCall: { name: 'search', args: { q: 'x' } }, thoughtSignature: 'FS' },
                        ],
                    },
                }],
            }),
        )
        const result = await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'search', parameters: {} }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(result.text).toBe('visible')
        expect(result.toolCalls).toMatchObject([{ name: 'search', arguments: '{"q":"x"}', signature: 'FS' }])
        expect(result.reasoning).toEqual([{ text: 'reasoning', signature: 'TS' }])
    })

    test('leaves call id empty when Gemini omits one (KV uniqueness handled downstream)', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'a', args: {} } }] } }] }),
        )
        const r = await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'a', parameters: {} }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(r.toolCalls![0].id).toBe('')
    })

    test('round-trips Gemini provider call id on both functionCall and functionResponse', async () => {
        // Parsing preserves the provider ID.
        const { fetchImpl } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { id: 'fc-7', name: 'a', args: {} } }] } }] }),
        )
        const r = await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'a', parameters: {} }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(r.toolCalls![0].id).toBe('fc-7')

        // Follow-up functionCall and functionResponse parts echo that ID.
        const { fetchImpl: f2, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: '', toolCalls: [{ id: 'fc-7', name: 'a', arguments: '{}' }] },
                    { role: 'tool', content: 'r', toolCallId: 'fc-7', name: 'a' },
                ],
                tools: [{ name: 'a', parameters: {} }],
                fetchImpl: f2,
            },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        expect(contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { id: 'fc-7', name: 'a', args: {} } }] })
        expect(contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { id: 'fc-7', name: 'a', response: { result: 'r' } } }] })
    })

    test('strips customBody.tools/toolConfig when the request carries no tools (off = hard gate)', async () => {
        const preset = makePreset({ customBody: { tools: [{ functionDeclarations: [{ name: 'sneaky' }] }], toolConfig: { functionCallingConfig: { mode: 'ANY' } } } })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(preset, { messages: [{ role: 'user', content: 'q' }], fetchImpl }, { apiKey: 'k' })
        expect(calls[0].body.tools).toBeUndefined()
        expect(calls[0].body.toolConfig).toBeUndefined()
    })

    test('resends model parts verbatim via providerEcho (preserves text-part thoughtSignature)', async () => {
        // Gemini may attach a signature to a text part as well as a function call.
        const rawParts = [
            { text: 'visible answer', thoughtSignature: 'TS-on-text' },
            { functionCall: { name: 'a', args: {} }, thoughtSignature: 'FS' },
        ]
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: 'visible answer', toolCalls: [{ id: '', name: 'a', arguments: '{}', signature: 'FS' }], providerEcho: rawParts },
                    { role: 'tool', content: 'r', toolCallId: '', name: 'a' },
                ],
                tools: [{ name: 'a', parameters: {} }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        expect(contents[1]).toEqual({ role: 'model', parts: rawParts })
    })

    test('URL-encodes modelId', async () => {
        const preset = makePreset({ userValues: { modelId: 'gemini/2.5-pro' } })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini%2F2.5-pro:generateContent')
    })

    test('throws invalid-request when modelId is missing', async () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                modelId: '',
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
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
            }),
        })
        const { fetchImpl } = captureFetch(jsonResponse({}))
        await expect(
            sendGoogleChatRequest(preset, { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({ kind: 'invalid-request', retryable: false })
    })

    test('customBody cannot inject systemInstruction when user provided no system message', async () => {
        const preset = makePreset({
            customBody: { systemInstruction: { parts: [{ text: 'HIJACK' }] }, extra: 'kept' },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: [{ role: 'user', content: 'hi' }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.systemInstruction).toBeUndefined()
        expect(calls[0].body.extra).toBe('kept')
    })

    test('customBody.systemInstruction cannot override user-provided system message', async () => {
        const preset = makePreset({
            customBody: { systemInstruction: { parts: [{ text: 'HIJACK' }] } },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.systemInstruction).toEqual({
            parts: [{ text: 'You are factual.' }],
        })
    })

    test('customBody.model cannot redirect the URL path modelId', async () => {
        const preset = makePreset({
            userValues: { modelId: 'gemini-real' },
            customBody: { model: 'HIJACK', generationConfig: { temperature: 0.5 } },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini-real:generateContent')
        expect(calls[0].body.model).toBeUndefined()
        expect(calls[0].body.generationConfig).toEqual({ temperature: 0.5 })
    })

    test('non-stream promptFeedback.blockReason throws invalid-request (non-retryable, non-eligible)', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                promptFeedback: {
                    blockReason: 'SAFETY',
                    blockReasonMessage: 'Blocked due to safety policy.',
                },
            }),
        )
        await expect(
            sendGoogleChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({
            kind: 'invalid-request',
            retryable: false,
            fallbackEligible: false,
            message: 'Gemini blocked the prompt: Blocked due to safety policy.',
        })
    })

    test('non-stream promptFeedback.blockReason without message falls back to the reason code', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
        )
        await expect(
            sendGoogleChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({
            kind: 'invalid-request',
            message: 'Gemini blocked the prompt: SAFETY',
        })
    })

    test('classifies HTTP 400 with parsed message', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse(
                { error: { code: 400, message: 'invalid argument', status: 'INVALID_ARGUMENT' } },
                { status: 400 },
            ),
        )
        await expect(
            sendGoogleChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({
            kind: 'invalid-request',
            status: 400,
            message: 'invalid argument',
        })
    })
})

describe('streamGoogleChatRequest', () => {
    test('yields accumulating textDelta from candidates parts and captures finishReason+usage', async () => {
        const { fetchImpl, calls } = captureFetch(
            sseResponse([
                'data: {"candidates":[{"content":{"parts":[{"text":"He"}],"role":"model"}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[{"text":"llo"}],"role":"model"}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}\n\n',
            ]),
        )
        const deltas: string[] = []
        let finishReason: string | undefined
        let usage: { promptTokens?: number } | undefined
        for await (const delta of streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )) {
            if (delta.textDelta) deltas.push(delta.textDelta)
            if (delta.finishReason) finishReason = delta.finishReason
            if (delta.usage) usage = delta.usage
        }
        expect(deltas.join('')).toBe('Hello')
        expect(finishReason).toBe('STOP')
        expect(usage).toEqual({ promptTokens: 3, completionTokens: 1, totalTokens: 4 })
        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini-demo:streamGenerateContent?alt=sse')
        expect(calls[0].headers.Accept).toBe('text/event-stream')
    })

    test('routes thought parts to reasoningDelta, never into the visible textDelta', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}],"role":"model"}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[{"text":"answer"}],"role":"model"}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
            ]),
        )
        const text: string[] = []
        const reasoning: string[] = []
        for await (const delta of streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )) {
            if (delta.textDelta) text.push(delta.textDelta)
            if (delta.reasoningDelta) reasoning.push(delta.reasoningDelta)
        }
        expect(text.join('')).toBe('answer')
        expect(reasoning.join('')).toBe('thinking...')
    })

    test('throws parse error on non-JSON SSE data', async () => {
        const { fetchImpl } = captureFetch(sseResponse(['data: not json\n\n']))
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        await expect(gen.next()).rejects.toMatchObject({ kind: 'parse' })
    })

    test('stream promptFeedback.blockReason throws invalid-request mid-stream', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'data: {"promptFeedback":{"blockReason":"SAFETY","blockReasonMessage":"Blocked due to safety policy."}}\n\n',
            ]),
        )
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            kind: 'invalid-request',
            retryable: false,
            fallbackEligible: false,
            message: 'Gemini blocked the prompt: Blocked due to safety policy.',
        })
    })

    test('classifies HTTP 429 before streaming starts', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { message: 'Rate limit exceeded' } }, { status: 429 }),
        )
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            kind: 'rate-limit',
            retryable: true,
            fallbackEligible: false,
        })
    })

    test('normalizes AbortError during stream body read', async () => {
        const abort = new Error('cancel')
        abort.name = 'AbortError'
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new TextEncoder().encode(
                    'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n',
                ))
                controller.error(abort)
            },
        })
        const fetchImpl: typeof fetch = decodingFetch(async () => new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        }))
        const gen = streamGoogleChatRequest(
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

describe('vision (Stage 3)', () => {
    test('appends an inlineData part (raw base64 + mimeType) to the user turn', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [{ role: 'user', content: 'look', images: [{ kind: 'image', base64: 'CCCC', mime: 'image/webp' }] }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        expect(contents[0]).toEqual({
            role: 'user',
            parts: [
                { text: 'look' },
                { inlineData: { mimeType: 'image/webp', data: 'CCCC' } },
            ],
        })
    })

    test('sends enabled audio/video inlineData and requests generated audio', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset({
                userValues: {
                    modelId: 'gemini-media',
                    customFlag_hasAudioOutput: true,
                },
            }),
            {
                messages: [{
                    role: 'user',
                    content: 'listen',
                    media: [
                        { kind: 'audio', base64: 'AA', mime: 'audio/wav' },
                        { kind: 'video', base64: 'VV', mime: 'video/mp4' },
                    ],
                }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        expect(contents[0]).toEqual({
            role: 'user',
            parts: [
                { text: 'listen' },
                { inlineData: { mimeType: 'audio/wav', data: 'AA' } },
                { inlineData: { mimeType: 'video/mp4', data: 'VV' } },
            ],
        })
        expect(calls[0].body.generationConfig).toMatchObject({
            responseModalities: ['TEXT', 'AUDIO'],
        })
    })

    test('requests IMAGE-only output for registry image-generation profiles', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                candidates: [{
                    content: {
                        parts: [{ inlineData: { mimeType: 'image/png', data: 'IMG' } }],
                    },
                }],
            }),
        )
        await sendGoogleChatRequest(
            makePreset({
                profileSnapshot: makeSnapshot({
                    modelId: 'gemini-2.5-flash-image',
                    capabilities: ['streaming', 'image-output'],
                }),
            }),
            {
                messages: [{ role: 'user', content: 'draw a cat' }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )

        expect(calls[0].body.generationConfig).toMatchObject({
            responseModalities: ['IMAGE'],
        })
    })

    test('returns generated Gemini image/audio parts separately from text', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                candidates: [{
                    content: {
                        parts: [
                            { text: 'done' },
                            { inlineData: { mimeType: 'image/png', data: 'IMG' } },
                            { inlineData: { mimeType: 'audio/wav', data: 'AUD' } },
                        ],
                    },
                }],
            }),
        )
        const response = await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'make media' }], fetchImpl },
            { apiKey: 'k' },
        )

        expect(response.text).toBe('done')
        expect(response.media).toEqual([
            { kind: 'image', mime: 'image/png', base64: 'IMG' },
            { kind: 'audio', mime: 'audio/wav', base64: 'AUD' },
        ])
    })

    test('a pure-image user turn (empty text) omits the empty text part', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: '', images: [{ kind: 'image', base64: 'DD', mime: 'image/png' }] }], fetchImpl },
            { apiKey: 'k' },
        )
        const contents = calls[0].body.contents as Array<Record<string, unknown>>
        expect(contents[0]).toEqual({ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'DD' } }] })
    })

    test('maps the preset Vision Quality to generationConfig.mediaResolution', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset({
                profileSnapshot: makeSnapshot({
                    profileId: 'vertex-gemini-native:standard',
                    providerBaseId: 'vertex-gemini-native',
                }),
                gptVisionQuality: 'medium',
            }),
            {
                messages: [{ role: 'user', content: 'inspect', images: [{ kind: 'image', base64: 'MM', mime: 'image/png' }] }],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        expect(calls[0].body.generationConfig).toEqual({
            mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
        })
    })
})

describe('context caching wiring', () => {
    beforeEach(() => {
        localStorage.clear()
        resetGeminiContextCacheRuntime()
        resetGeminiCacheWiringRuntime()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    function makeCacheContext(): AdapterCacheContext {
        return { promptCaching: { enabled: true }, chatKey: 'chat-1', task: 'model', presetId: 'preset-google' }
    }

    // Route chat and cachedContents calls through one fake endpoint.
    function routedFetch(chatResponse: () => Response): {
        fetchImpl: typeof fetch
        calls: CapturedCall[]
    } {
        const calls: CapturedCall[] = []
        let created = 0
        const fetchImpl: typeof fetch = decodingFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            calls.push({
                url,
                method: (init?.method ?? 'GET') as string,
                headers: (init?.headers as Record<string, string>) ?? {},
                body: init?.body != null ? JSON.parse(init.body as string) : {},
            })
            if (url.includes('/cachedContents')) {
                if (init?.method === 'POST') {
                    created++
                    return jsonResponse({ name: `cachedContents/created-${created}` })
                }
                return jsonResponse({})
            }
            return chatResponse()
        })
        return { fetchImpl, calls }
    }

    function chatJson(promptTokenCount: number): () => Response {
        return () => jsonResponse({
            candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount, candidatesTokenCount: 2, totalTokenCount: promptTokenCount + 2 },
        })
    }

    // Cache the first user turn after the system instruction.
    const turnOneMessages: AdapterChatMessage[] = [
        { role: 'system', content: 'You are factual.' },
        { role: 'user', content: 'turn 1', cachePoint: true },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'turn 2' },
    ]

    test('first turn sends uncached, then creates the cache for the boundary prefix in the background', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        expect(calls[0].body.cachedContent).toBeUndefined()
        expect(calls[0].body.contents).toHaveLength(3)
        expect(calls[0].body.systemInstruction).toBeDefined()
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        expect(calls[1].method).toBe('POST')
        expect(calls[1].url).toBe('https://demo.test/v1beta/cachedContents')
        expect(calls[1].headers['x-goog-api-key']).toBe('k')
        expect(calls[1].body).toEqual({
            model: 'models/gemini-demo',
            ttl: '600s',
            systemInstruction: { parts: [{ text: 'You are factual.' }] },
            contents: [{ role: 'user', parts: [{ text: 'turn 1' }] }],
        })
    })

    // Service-account auth also exercises Gemini's Vertex endpoint shape.
    function makeVertexPreset(): ModelPreset {
        return makePreset({
            profileSnapshot: makeSnapshot({
                providerBaseId: 'vertex-gemini-native',
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: {
                    kind: 'static',
                    url: 'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/google/models',
                },
            }),
        })
    }

    test('Vertex: cachedContents URL is location-rooted and the create model is the full resource path', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makeVertexPreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: VERTEX_SA_JSON },
        )
        expect(calls[0].url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global'
            + '/publishers/google/models/gemini-demo:generateContent',
        )
        expect(calls[0].headers['Authorization']).toBe('Bearer [server-auth]')
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        expect(calls[1].method).toBe('POST')
        expect(calls[1].url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/cachedContents',
        )
        expect(calls[1].headers['Authorization']).toBe('Bearer [server-auth]')
        expect(calls[1].body).toEqual({
            model: 'projects/my-proj/locations/global/publishers/google/models/gemini-demo',
            ttl: '600s',
            systemInstruction: { parts: [{ text: 'You are factual.' }] },
            contents: [{ role: 'user', parts: [{ text: 'turn 1' }] }],
        })
    })

    test('Vertex: second turn applies the cache (cachedContent + suffix), Bearer auth reused', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makeVertexPreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: VERTEX_SA_JSON },
        )
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        const turnTwoMessages: AdapterChatMessage[] = [
            ...turnOneMessages,
            { role: 'assistant', content: 'reply 2' },
            { role: 'user', content: 'turn 3' },
        ]
        await sendGoogleChatRequest(
            makeVertexPreset(),
            { messages: turnTwoMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: VERTEX_SA_JSON },
        )
        expect(calls[2].body.cachedContent).toBe('cachedContents/created-1')
        expect(calls[2].body.systemInstruction).toBeUndefined()
        expect(calls[2].headers['Authorization']).toBe('Bearer [server-auth]')
    })

    test('second turn applies the cache: cachedContent + suffix only, systemInstruction stripped', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        const turnTwoMessages: AdapterChatMessage[] = [
            ...turnOneMessages,
            { role: 'assistant', content: 'reply 2' },
            { role: 'user', content: 'turn 3' },
        ]
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnTwoMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        expect(calls[2].body.cachedContent).toBe('cachedContents/created-1')
        expect(calls[2].body.contents).toEqual([
            { role: 'model', parts: [{ text: 'reply 1' }] },
            { role: 'user', parts: [{ text: 'turn 2' }] },
            { role: 'model', parts: [{ text: 'reply 2' }] },
            { role: 'user', parts: [{ text: 'turn 3' }] },
        ])
        expect(calls[2].body.systemInstruction).toBeUndefined()
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(3)
    })

    test('a prefix edit invalidates: stale cache deleted, request uncached, cache recreated', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        const editedMessages: AdapterChatMessage[] = [
            { role: 'system', content: 'You are factual.' },
            { role: 'user', content: 'turn 1 EDITED', cachePoint: true },
            { role: 'assistant', content: 'reply 1' },
            { role: 'user', content: 'turn 2' },
        ]
        await sendGoogleChatRequest(
            makePreset(),
            { messages: editedMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(5)
        const remove = calls.find((c) => c.method === 'DELETE')
        expect(remove?.url).toBe('https://demo.test/v1beta/cachedContents/created-1')
        const chat = calls.find((c, i) => i >= 2 && c.url.includes(':generateContent'))
        expect(chat?.body.cachedContent).toBeUndefined()
        expect(chat?.body.contents).toHaveLength(3)
        const recreate = calls.find((c, i) => i >= 2 && c.method === 'POST' && c.url.endsWith('/cachedContents'))
        expect(recreate?.body.contents).toEqual([{ role: 'user', parts: [{ text: 'turn 1 EDITED' }] }])
    })

    test('a cache covering the whole prompt is never applied (empty-suffix guard)', async () => {
        const messages: AdapterChatMessage[] = [
            { role: 'system', content: 'You are factual.' },
            { role: 'user', content: 'turn 1' },
            { role: 'assistant', content: 'reply 1' },
            { role: 'user', content: 'turn 2', cachePoint: true },
        ]
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        // An end-of-prompt boundary leaves no suffix to send.
        await sendGoogleChatRequest(
            makePreset(),
            { messages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        expect(calls[2].body.cachedContent).toBeUndefined()
        expect(calls[2].body.contents).toHaveLength(3)
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(3)
    })

    test('no cachePoint in the prompt → caching never engages', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(1)
        expect(calls[0].body.cachedContent).toBeUndefined()
    })

    const systemOnlyCachePoint: AdapterChatMessage[] = [
        { role: 'system', content: 'You are factual.', cachePoint: true },
        { role: 'user', content: 'turn 1' },
    ]

    test('a system-only cachePoint caches the systemInstruction (boundary 0)', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: systemOnlyCachePoint, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        expect(calls[0].body.cachedContent).toBeUndefined()
        expect(calls[0].body.systemInstruction).toBeDefined()
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        expect(calls[1].method).toBe('POST')
        expect(calls[1].url).toBe('https://demo.test/v1beta/cachedContents')
        expect(calls[1].body).toEqual({
            model: 'models/gemini-demo',
            ttl: '600s',
            systemInstruction: { parts: [{ text: 'You are factual.' }] },
            contents: [],
        })
    })

    test('second turn applies the systemInstruction-only cache: cachedContent + full contents, systemInstruction stripped', async () => {
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages: systemOnlyCachePoint, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        const turnTwo: AdapterChatMessage[] = [
            { role: 'system', content: 'You are factual.', cachePoint: true },
            { role: 'user', content: 'turn 1' },
            { role: 'assistant', content: 'reply 1' },
            { role: 'user', content: 'turn 2' },
        ]
        await sendGoogleChatRequest(
            makePreset(),
            { messages: turnTwo, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        expect(calls[2].body.cachedContent).toBe('cachedContents/created-1')
        expect(calls[2].body.systemInstruction).toBeUndefined()
        expect(calls[2].body.contents).toEqual([
            { role: 'user', parts: [{ text: 'turn 1' }] },
            { role: 'model', parts: [{ text: 'reply 1' }] },
            { role: 'user', parts: [{ text: 'turn 2' }] },
        ])
    })

    test('a chat cachePoint wins over a system cachePoint (deeper boundary)', async () => {
        const messages: AdapterChatMessage[] = [
            { role: 'system', content: 'You are factual.', cachePoint: true },
            { role: 'user', content: 'turn 1', cachePoint: true },
            { role: 'assistant', content: 'reply 1' },
            { role: 'user', content: 'turn 2' },
        ]
        const { fetchImpl, calls } = routedFetch(chatJson(10_000))
        await sendGoogleChatRequest(
            makePreset(),
            { messages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        // The deeper chat boundary wins over the system-only boundary.
        expect(calls[1].method).toBe('POST')
        expect(calls[1].body).toEqual({
            model: 'models/gemini-demo',
            ttl: '600s',
            systemInstruction: { parts: [{ text: 'You are factual.' }] },
            contents: [{ role: 'user', parts: [{ text: 'turn 1' }] }],
        })
    })

    test('stream completion drives cache creation from the last chunk usage', async () => {
        const { fetchImpl, calls } = routedFetch(() => sseResponse([
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10000,"candidatesTokenCount":2,"totalTokenCount":10002}}\n\n',
        ]))
        for await (const _ of streamGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )) { /* drain */ }
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        expect(calls[1].method).toBe('POST')
        expect(calls[1].url).toBe('https://demo.test/v1beta/cachedContents')
    })

    test('a cache-API failure never disturbs the chat (creation POST fails, response still resolves)', async () => {
        const calls: CapturedCall[] = []
        const fetchImpl: typeof fetch = decodingFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            calls.push({
                url,
                method: (init?.method ?? 'GET') as string,
                headers: (init?.headers as Record<string, string>) ?? {},
                body: init?.body != null ? JSON.parse(init.body as string) : {},
            })
            if (url.includes('/cachedContents')) return jsonResponse({}, { status: 403 })
            return chatJson(10_000)()
        })
        const result = await sendGoogleChatRequest(
            makePreset(),
            { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
            { apiKey: 'k' },
        )
        expect(result.text).toBe('ok')
        await settleGeminiCacheTasks()
        expect(calls).toHaveLength(2)
        const chatCalls = calls.filter((c) => c.url.includes(':generateContent'))
        expect(chatCalls).toHaveLength(1)
    })

    test.each([403, 404] as const)(
        'retries an applied cache rejected with HTTP %i without cachedContent',
        async status => {
            const createdName = 'cachedContents/evicted-1'
            const calls: CapturedCall[] = []
            const fetchImpl: typeof fetch = decodingFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
                const body = init?.body != null ? JSON.parse(init.body as string) : {}
                calls.push({ url, method: (init?.method ?? 'GET') as string, headers: (init?.headers as Record<string, string>) ?? {}, body })
                if (url.includes('/cachedContents')) {
                    if (init?.method === 'POST') {
                        return jsonResponse({ name: createdName })
                    }
                    return jsonResponse({})
                }
                if (body.cachedContent) return jsonResponse({ error: { message: 'cache not found' } }, { status })
                return chatJson(10_000)()
            })
            await sendGoogleChatRequest(
                makePreset(),
                { messages: turnOneMessages, fetchImpl, cache: makeCacheContext() },
                { apiKey: 'k' },
            )
            await settleGeminiCacheTasks()
            expect(calls.some((c) => c.method === 'POST')).toBe(true)
            const turnTwoMessages: AdapterChatMessage[] = [
                ...turnOneMessages,
                { role: 'assistant', content: 'reply 2' },
                { role: 'user', content: 'turn 3' },
            ]
            const result = await sendGoogleChatRequest(
                makePreset(),
                { messages: turnTwoMessages, fetchImpl, cache: makeCacheContext() },
                { apiKey: 'k' },
            )
            expect(result.text).toBe('ok')
            const turn2Chats = calls.filter((c, i) => i >= 2 && c.url.includes(':generateContent'))
            expect(turn2Chats).toHaveLength(2)
            expect(turn2Chats[0].body.cachedContent).toBe(createdName)
            expect(turn2Chats[1].body.cachedContent).toBeUndefined()
        },
    )

    test('parses cachedContentTokenCount into usage.cachedTokens', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({
            candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, cachedContentTokenCount: 7 },
        }))
        const result = await sendGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedTokens: 7 })
    })
})


describe('persisted Gemini thought context', () => {
    test('keeps an empty signature part through edits and reverts using the response UUID', async () => {
        let context: ThoughtSignatureContext | undefined
        const projection = createDecodedChatProjection()
        await decodeAdapterResponseBody(
            { adapterKind: 'google-gemini', stream: true },
            new Response([
                'data: {"candidates":[{"content":{"parts":[{"text":"original"}]}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"opaque"}]}}]}\n\n',
            ].join('')).body!,
            event => projection.apply(event),
            value => { context = value },
        )
        expect(projection.content()).toBe('original')
        const records = [{ responseId: 'response', adapterKind: 'google-gemini', model: 'gemini-demo', turns: [context!] }]
        for (const text of ['edited by plugin', 'original']) {
            const history = formatPresetMessages([
                { role: 'assistant', memo: 'branched-message', responseId: 'response', content: text },
                { role: 'assistant', memo: 'branched-message', responseId: 'new-response', content: 'original' },
                { role: 'user', content: 'next' },
            ], { foldSystemPrompt: false, keepFirstSystemPrompt: false, alternateRole: true, startWithUserInput: false }, {}, new Set(['response']))
            const messages = history.map(message => toAdapterMessage(message))
            const restored = restoreThoughtSignatures(messages, records)
            const { fetchImpl, calls } = captureFetch(jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }))
            await sendGoogleChatRequest(makePreset(), { messages: restored, fetchImpl }, { apiKey: 'test' })
            expect(calls[0].body.contents).toEqual([
                { role: 'model', parts: [{ text }, { text: '', thoughtSignature: 'opaque' }] },
                { role: 'model', parts: [{ text: 'original' }] },
                { role: 'user', parts: [{ text: 'next' }] },
            ])
            expect(messages[0].thoughtContext).toBeUndefined()
        }
    })

    test('reports the context of complete frames when the journal is truncated', async () => {
        let context: ThoughtSignatureContext | undefined
        await expect(decodeAdapterResponseBody(
            { adapterKind: 'google-gemini', stream: true },
            new Response([
                'data: {"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"opaque"}]}}]}\n\n',
                'data: {"candidates":[',
            ].join('')).body!,
            () => {},
            value => { context = value },
        )).rejects.toThrow()
        expect(context?.geminiParts).toEqual([{ text: '', thoughtSignature: 'opaque' }])
    })

    test('restores parallel and sequential tool rounds before their results', async () => {
        const responses = [
            [{ text: 'reasoning', thought: true, thoughtSignature: 'thinking' },
                { functionCall: { name: 'search', args: { q: 'a' } }, thoughtSignature: 'first' },
                { functionCall: { name: 'search', args: { q: 'b' } } }],
            [{ functionCall: { id: 'c', name: 'lookup', args: {} }, thoughtSignature: 'second' }],
            [{ text: 'original final', thoughtSignature: 'final' }],
        ]
        const turns = responses.map(parts => {
            const collector = createThoughtSignatureCollector('google-gemini')
            collector.add({ candidates: [{ content: { parts } }] })
            return collector.finish()!
        })
        const callsById = {
            a: { id: 'a', name: 'search', arg: { q: 'a' } },
            b: { id: 'b', name: 'search', arg: { q: 'b' } },
            c: { id: 'c', name: 'lookup', arg: {} },
        }
        const messages = await expandAdapterMessages([
            { role: 'assistant', memo: 'branched-message', responseId: 'response', content: '<Thoughts>reasoning</Thoughts>looking<tool_call>a</tool_call><tool_call>b</tool_call><tool_call>c</tool_call>edited final' },
        ], async marker => {
            const id = marker.slice('<tool_call>'.length, -'</tool_call>'.length) as keyof typeof callsById
            return { call: callsById[id], response: [{ type: 'text', text: `result ${id}` }] }
        })
        const restored = restoreThoughtSignatures(messages, [{ responseId: 'response', adapterKind: 'google-gemini', model: 'gemini-demo', turns }])
        const { fetchImpl, calls } = captureFetch(jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }))
        await sendGoogleChatRequest(makePreset(), { messages: restored, fetchImpl }, { apiKey: 'test' })
        expect(calls[0].body.contents).toEqual([
            { role: 'model', parts: [
                { text: 'reasoning', thought: true, thoughtSignature: 'thinking' },
                { text: 'looking' },
                { functionCall: { id: 'a', name: 'search', args: { q: 'a' } }, thoughtSignature: 'first' },
                { functionCall: { id: 'b', name: 'search', args: { q: 'b' } } },
            ] },
            { role: 'user', parts: [
                { functionResponse: { id: 'a', name: 'search', response: { result: 'result a' } } },
                { functionResponse: { id: 'b', name: 'search', response: { result: 'result b' } } },
            ] },
            { role: 'model', parts: [{ functionCall: { id: 'c', name: 'lookup', args: {} }, thoughtSignature: 'second' }] },
            { role: 'user', parts: [{ functionResponse: { id: 'c', name: 'lookup', response: { result: 'result c' } } }] },
            { role: 'model', parts: [{ text: 'edited final', thoughtSignature: 'final' }] },
        ])
    })
})

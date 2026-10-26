import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'

const { mockDb } = vi.hoisted(() => ({
    mockDb: {
        maxResponse: 2048,
        modelPresetDefaultMaxResponse: 4096,
        temperature: 100,
        top_p: 1,
        top_k: 0,
        repetition_penalty: 1,
        min_p: 0,
        top_a: 0,
        frequencyPenalty: 0,
        PresensePenalty: 0,
        thinkingTokens: 0,
        reasoningEffort: 1,
        verbosity: 1,
        seperateParametersEnabled: false,
        currentPluginProvider: '',
        systemRoleReplacement: 'user',
        systemContentReplacement: 'system: {{slot}}',
    } as Record<string, any>,
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb,
    getCurrentChat: () => null,
    getCurrentCharacter: () => null,
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
}))
vi.mock('src/ts/network/llmTransport', async () => {
    const { decodingFetch } = await import('src/ts/preset/adapter/__testDecodingFetch')
    return {
        createLLMTransportFetch: () => decodingFetch((url, options) => fetch(url, options)),
    }
})
vi.mock('src/ts/process/mcp/mcp', async importOriginal => ({
    ...await importOriginal<any>(),
    callTool: vi.fn(async () => [{ type: 'text', text: 'Synthetic tool result' }]),
    encodeToolCall: async () => '<tool_call>Synthetic saved tool result</tool_call>',
}))

import { pluginProviderRequestContextKey, pluginRuntime } from 'src/ts/plugins/pluginRuntime'
import { customV3ProviderMetaStore } from 'src/ts/plugins/apiV3/v3.svelte'
import {
    modelPresetRequestFailurePolicy,
    requestModelPresetData,
    requestChatDataMain,
    resolvePresetStreaming,
    testModelPreset,
} from './request'
import { ModelPresetAdapterError } from 'src/ts/preset/adapter'
import type { ModelPreset } from 'src/ts/preset/types'
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from 'src/ts/model/types'
import { requestStatuses, stopStatusTimer } from 'src/ts/status/requestStatus'
import { configureRevenantGenerationClient, trackRevenantGenerationJob } from '../revenant/transport/client'
import { collectStreamingText } from './shared'
import { callTool } from '../mcp/mcp'

function pluginPreset(): ModelPreset {
    return {
        id: 'plugin-preset',
        name: 'Plugin preset',
        profileSnapshot: {
            profileId: 'plugin:test-provider',
            providerBaseId: 'developer-plugin',
            adapterKind: 'plugin',
            auth: { kind: 'none', fields: [] },
            endpoint: { kind: 'static', url: 'plugin://test-provider' },
            modelId: 'pluginmodel:::test-provider',
            schema: [
                {
                    key: 'max_tokens',
                    type: 'integer',
                    label: 'Max response tokens',
                    default: 4096,
                    mapsTo: { target: 'body', path: 'max_tokens' },
                },
                {
                    key: 'temperature',
                    type: 'number',
                    label: 'Temperature',
                    default: 1,
                    mapsTo: { target: 'body', path: 'temperature' },
                },
            ],
            uiSchema: { groups: [], fields: [] },
            defaults: { max_tokens: 4096, temperature: 1 },
        },
        userValues: { max_tokens: 1234, temperature: 0.25 },
        createdAt: 1,
        updatedAt: 1,
    }
}

describe('plugin-backed ModelPreset dispatch', () => {
    afterEach(() => vi.unstubAllGlobals())
    beforeEach(() => {
        vi.clearAllMocks()
        pluginRuntime.providers.clear()
        customV3ProviderMetaStore.length = 0
        requestStatuses.set(new Map())
        stopStatusTimer()
        delete mockDb.showRequestStatus
    })

    test('resolves an auxiliary request from its captured chat instead of the current selection', async () => {
        const preset = pluginPreset()
        mockDb.modelPresets = [preset]
        customV3ProviderMetaStore.push({
            id: 'pluginmodel:::test-provider', name: 'Test provider',
            provider: LLMProvider.AsIs, format: LLMFormat.Plugin,
            flags: [LLMFlags.hasFullSystemPrompt], parameters: [], tokenizer: LLMTokenizer.Unknown,
        })
        pluginRuntime.providers.set('test-provider', async () => ({ success: true, content: 'captured reply' }))
        try {
            const result = await requestChatDataMain({
                formated: [{ role: 'user', content: 'hello' }], bias: {},
                currentChat: { id: 'origin', modelBinding: { main: preset.id, sub: preset.id } } as never,
            }, 'memory')
            expect(result).toMatchObject({ type: 'success', result: 'captured reply' })
        } finally {
            delete mockDb.modelPresets
        }
    })

    test('defaults standalone LLM calls to a consumed non-streaming result', () => {
        const preset = pluginPreset()
        preset.useStreaming = true

        expect(resolvePresetStreaming(preset, {
            formated: [],
            bias: {},
            mode: 'otherAx',
        }, true)).toBe(false)
        expect(resolvePresetStreaming(preset, {
            formated: [],
            bias: {},
            mode: 'otherAx',
            useStreaming: true,
        }, true)).toBe(true)
        expect(resolvePresetStreaming(preset, {
            formated: [],
            bias: {},
            mode: 'model',
            chatId: 'message-1',
        }, true)).toBe(true)
    })

    test('stops retrying invalid provider requests but retains transient retries', () => {
        expect(modelPresetRequestFailurePolicy(
            new ModelPresetAdapterError(
                'invalid-request',
                'Requests ending with a model turn are not supported.',
                { status: 400 },
            ),
        )).toEqual({ noRetry: true, failByServerError: false })

        expect(modelPresetRequestFailurePolicy(
            new ModelPresetAdapterError('server', 'temporarily unavailable', { status: 503 }),
        )).toEqual({ noRetry: false, failByServerError: true })

        expect(modelPresetRequestFailurePolicy(
            new ModelPresetAdapterError('server', 'bad gateway', { status: 502 }),
        )).toEqual({ noRetry: false, failByServerError: false })

        expect(modelPresetRequestFailurePolicy(
            new ModelPresetAdapterError('rate-limit', 'slow down', {
                status: 429,
                retryAfterMs: 4_000,
            }),
        )).toEqual({ noRetry: false, failByServerError: true, retryAfterMs: 4_000 })
    })

    test('calls the registered addProvider function with preset-scoped parameters', async () => {
        let received: any
        let receivedSignal: AbortSignal | undefined
        customV3ProviderMetaStore.push({
            id: 'pluginmodel:::test-provider',
            name: 'Test provider',
            provider: LLMProvider.AsIs,
            format: LLMFormat.Plugin,
            flags: [LLMFlags.hasFullSystemPrompt],
            parameters: ['temperature'],
            tokenizer: LLMTokenizer.Unknown,
        })
        pluginRuntime.providers.set('test-provider', async (args, abortSignal) => {
            received = args
            receivedSignal = abortSignal
            return { success: true, content: 'plugin reply' }
        })

        const result = await testModelPreset(pluginPreset(), 'hello')

        expect(result.ok).toBe(true)
        expect(result.message).toBe('plugin reply')
        expect(received).toMatchObject({
            prompt_chat: [{ role: 'user', content: 'hello' }],
            max_tokens: 1234,
            temperature: 0.25,
            mode: 'otherAx',
        })
        expect(receivedSignal).toBeInstanceOf(AbortSignal)
        expect(received[pluginProviderRequestContextKey]).toMatchObject({
            interceptor: 'model_preset',
            generationRequest: {
                job: {
                    jobType: 'otherAx',
                },
            },
        })
        const status = [...get(requestStatuses).values()][0]
        expect(status).toMatchObject({
            label: 'Plugin preset',
            phase: 'done',
            responseText: 'plugin reply',
        })
    })

    test('blocks a legacy addProvider function without API 3.0 metadata', async () => {
        pluginRuntime.providers.set('test-provider', async () => {
            return { success: true, content: 'must not run' }
        })
        const result = await testModelPreset(pluginPreset(), 'hello')
        expect(result.ok).toBe(false)
        expect(result.message).toContain('3.0')
    })

    test('drains a plugin stream when the caller disables streaming', async () => {
        mockDb.showRequestStatus = false
        customV3ProviderMetaStore.push({
            id: 'pluginmodel:::test-provider',
            name: 'Test provider',
            provider: LLMProvider.AsIs,
            format: LLMFormat.Plugin,
            flags: [LLMFlags.hasFullSystemPrompt, LLMFlags.hasStreaming],
            parameters: [],
            tokenizer: LLMTokenizer.Unknown,
        })
        pluginRuntime.providers.set('test-provider', async () => ({
            success: true,
            content: new ReadableStream<string>({
                start(controller) {
                    controller.enqueue('plugin ')
                    controller.enqueue('reply')
                    controller.close()
                },
            }),
        }))
        const preset = pluginPreset()
        preset.useStreaming = true
        preset.profileSnapshot.capabilities = ['streaming']

        // The editor test path explicitly opts out of a streaming response even
        // if the plugin chooses a streaming transport internally.
        const result = await testModelPreset(preset, 'hello')

        expect(result).toMatchObject({
            ok: true,
            message: 'plugin reply',
        })
    })

    test.each([false, true])('checkpoints the completed plugin reply for tool-call processing (streaming=%s)', async streaming => {
        mockDb.showRequestStatus = false
        customV3ProviderMetaStore.push({
            id: 'pluginmodel:::test-provider', name: 'Test provider',
            provider: LLMProvider.AsIs, format: LLMFormat.Plugin,
            flags: [LLMFlags.hasFullSystemPrompt, LLMFlags.hasStreaming],
            parameters: [], tokenizer: LLMTokenizer.Unknown,
        })
        pluginRuntime.providers.set('test-provider', async () => ({
            success: true,
            content: streaming ? new ReadableStream<string>({
                start(controller) {
                    controller.enqueue('Processed ')
                    controller.enqueue('reply')
                    controller.close()
                },
            }) : 'Processed reply',
        }))
        configureRevenantGenerationClient({ createAuth: async () => 'auth', getSyncClientId: () => 'client' })
        trackRevenantGenerationJob('plugin-message', 'tool-round')
        const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response('{}'))
        vi.stubGlobal('fetch', fetch)
        const preset = pluginPreset()
        preset.useStreaming = true
        preset.profileSnapshot.capabilities = ['streaming']
        const result = await requestModelPresetData({
            formated: [{ role: 'user', content: 'Synthetic prompt' }], bias: {},
            chatId: 'plugin-message', useStreaming: streaming, revenantWorkflowId: 'plugin-workflow',
        }, preset, 'model')

        const text = result.type === 'streaming' ? await collectStreamingText(result.result) : result.result
        expect(text).toBe('Processed reply')
        expect(fetch).toHaveBeenCalledOnce()
        expect(fetch.mock.calls[0][0]).toBe('/api/generation/jobs/tool-round/provider-result')
        expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({ content: 'Processed reply' })
    })
})

describe('HTTP ModelPreset completion', () => {
    afterEach(() => vi.unstubAllGlobals())

    test.each([200, 409])('completes the entire tool loop through the shared result checkpoint (HTTP %s)', async checkpointStatus => {
        vi.clearAllMocks()
        mockDb.showRequestStatus = false
        configureRevenantGenerationClient({ createAuth: async () => 'auth', getSyncClientId: () => 'client' })
        trackRevenantGenerationJob('http-message', 'http-round')
        let round = 0
        let checkpoint: Record<string, unknown> | undefined
        vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
            if (url.startsWith('/api/generation/jobs/')) {
                checkpoint = JSON.parse(options.body as string)
                return new Response(JSON.stringify({ error: 'Completion refused' }), { status: checkpointStatus })
            }
            const message = round++ === 0
                ? { content: 'Checking', tool_calls: [{
                    id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' },
                }] }
                : { content: 'Final answer' }
            return new Response(JSON.stringify({ choices: [{ message }] }))
        }))
        const preset = pluginPreset()
        preset.profileSnapshot = {
            ...preset.profileSnapshot,
            profileId: 'http-profile', providerBaseId: 'test-http',
            adapterKind: 'openai-compatible', modelId: 'test-model',
            endpoint: { kind: 'static', url: 'https://provider.test/v1/chat/completions' },
            capabilities: ['tools'],
        }
        preset.toolUse = true
        const result = await requestModelPresetData({
            formated: [{ role: 'user', content: 'Synthetic prompt' }], bias: {},
            chatId: 'http-message', revenantWorkflowId: 'http-workflow',
            tools: [{ name: 'lookup', description: '', inputSchema: {} }], rememberToolUsage: true,
        }, preset, 'model')

        const text = 'Checking\n\n<tool_call>Synthetic saved tool result</tool_call>\n\nFinal answer'
        expect(checkpoint).toEqual({ content: text })
        expect(round).toBe(2)
        expect(callTool).toHaveBeenCalledOnce()
        expect(result).toMatchObject(checkpointStatus === 200
            ? { type: 'success', result: text, toolExecuted: true }
            : { type: 'fail', noRetry: true, result: 'HTTP 409: Completion refused' })
    })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'
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

import { pluginProviderRequestContextKey, pluginV2 } from 'src/ts/plugins/plugins.svelte'
import { customV3ProviderMetaStore } from 'src/ts/plugins/apiV3/v3.svelte'
import { testModelPreset } from './request'
import type { ModelPreset } from 'src/ts/preset/types'
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from 'src/ts/model/types'
import { requestStatuses, stopStatusTimer } from 'src/ts/status/requestStatus'

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
    beforeEach(() => {
        pluginV2.providers.clear()
        pluginV2.providerOptions.clear()
        customV3ProviderMetaStore.length = 0
        requestStatuses.set(new Map())
        stopStatusTimer()
        delete mockDb.showRequestStatus
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
        pluginV2.providers.set('test-provider', async (args, abortSignal) => {
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
            mode: 'model',
        })
        expect(receivedSignal).toBeInstanceOf(AbortSignal)
        expect(received[pluginProviderRequestContextKey]).toMatchObject({
            interceptor: 'model_preset',
            generationContext: {
                jobType: 'otherAx',
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
        pluginV2.providers.set('test-provider', async () => {
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
        pluginV2.providers.set('test-provider', async () => ({
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
})

import { describe, expect, test } from 'vitest'
import type { ModelPreset } from '../types'
import { loadSpecialRegistry } from '../registry/loader'
import { resolveSnapshot } from '../registry/snapshot'
import { buildPreparedRequest } from './buildRequest'
import { resolveModelPresetAdapterKind } from './openaiApiMode'
import { previewGoogleChatRequest } from './googleGemini'
import { previewChatRequest } from './openaiCompatible'
import { previewResponsesRequest } from './openaiResponses'
import { previewAnthropicChatRequest } from './anthropicMessages'
import {
    hasCustomFlag,
    resolveCustomRuntimePreset,
    resolvePresetAuth,
} from './customPreset'

function preset(values: Record<string, unknown>): ModelPreset {
    return {
        id: 'custom-preset',
        name: 'Custom',
        profileSnapshot: resolveSnapshot(loadSpecialRegistry(), 'developer:custom'),
        userValues: {
            customFormat: 'openai-chat',
            endpointUrl: 'https://custom.test/v1/chat/completions',
            modelId: 'my-model',
            customAuthKind: 'bearer',
            ...values,
        },
        createdAt: 0,
        updatedAt: 0,
    }
}

describe('Developer Custom preset', () => {
    test('exposes the supported request controls without raw payload overrides', () => {
        const snapshot = preset({}).profileSnapshot
        const schemaKeys = new Set(snapshot.schema.map(field => field.key))
        const uiKeys = new Set(snapshot.uiSchema.fields.map(field => field.key))
        const supportedControls = [
            'customFormat',
            'endpointUrl',
            'modelId',
            'customAuthKind',
            'apiKey',
            'max_tokens',
            'temperature',
            'top_k',
            'top_p',
            'min_p',
            'top_a',
            'repetition_penalty',
            'frequency_penalty',
            'presence_penalty',
            'seed',
            'stopSequences',
            'reasoning_effort',
            'thinking_tokens',
            'verbosity',
            'prompt_cache_mode',
        ]

        for (const key of supportedControls) {
            expect(schemaKeys.has(key), `schema is missing ${key}`).toBe(true)
            expect(uiKeys.has(key), `UI schema is missing ${key}`).toBe(true)
        }
        expect(snapshot.uiSchema.fields.filter(field => field.key === 'apiKey')).toHaveLength(1)

        const unsupportedOverrides = [
            'customBody',
            'customHeaders',
            'customSupportsTools',
            'customSupportsJson',
            'customSupportsReasoning',
            'customFlag_hasImageInput',
            'customFlag_hasFullSystemPrompt',
            'customFlag_hasFirstSystemPrompt',
            'customFlag_hasStreaming',
            'customFlag_requiresAlternateRole',
            'customFlag_mustStartWithUserInput',
            'customFlag_claudeXHighEffort',
            'customFlag_claudeAdaptiveThinking',
            'customFlag_claudeThinking',
            'claudeThinkingBudget',
            'customFlag_geminiBlockOff',
            'customFlag_noCivilIntegrity',
            'customFlag_hasCache',
            'customFlag_poolSupported',
            'customFlag_deepSeekPrefix',
            'customFlag_deepSeekThinkingToggle',
        ]
        for (const key of unsupportedOverrides) {
            expect(schemaKeys.has(key), `unsupported override ${key} is exposed`).toBe(false)
        }
        expect(snapshot.uiSchema.groups.some(group => group.id === 'payload')).toBe(false)
    })

    test.each([
        ['openai-chat', 'openai-compatible'],
        ['openai-responses', 'openai-responses'],
        ['anthropic-messages', 'anthropic-messages'],
        ['google-gemini', 'google-gemini'],
    ] as const)('routes %s through the current %s adapter', (format, expected) => {
        expect(resolveModelPresetAdapterKind(preset({ customFormat: format }))).toBe(expected)
    })

    test('maps OpenAI sampling and applies final freeform parameters', () => {
        const value = preset({
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            max_tokens: 2048,
            reasoning_effort: 'high',
            verbosity: 'low',
            prompt_cache_mode: 'explicit',
            stopSequences: ['</s>', '###'],
        })
        value.additionalParamsText = [
            'temperature=1.1',
            'reasoning=json::{"effort":"high"}',
            'header::X-Custom=yes',
            'header::X-Trace=abc',
        ].join('\n')

        const result = buildPreparedRequest({
            preset: value,
            credential: { apiKey: 'secret' },
        })

        expect(result.url).toBe('https://custom.test/v1/chat/completions')
        expect(result.body).toMatchObject({
            max_tokens: 2048,
            temperature: 1.1,
            top_p: 0.9,
            top_k: 40,
            reasoning_effort: 'high',
            verbosity: 'low',
            prompt_cache_options: { mode: 'explicit' },
            stop: ['</s>', '###'],
            reasoning: { effort: 'high' },
        })
        expect(result.headers).toMatchObject({
            Authorization: 'Bearer secret',
            'X-Custom': 'yes',
            'X-Trace': 'abc',
        })
    })

    test.each(['openai-chat', 'openai-responses'] as const)(
        'treats reasoning effort none as disabled for %s',
        (customFormat) => {
            const value = preset({ customFormat, reasoning_effort: 'none' })
            const result = buildPreparedRequest({
                preset: value,
                credential: { apiKey: 'secret' },
            })
            const runtime = resolveCustomRuntimePreset(value)

            expect(result.body).not.toHaveProperty('reasoning_effort')
            expect(result.body).not.toHaveProperty('reasoning')
            expect(runtime.profileSnapshot.capabilities).not.toContain('reasoning')
        },
    )

    test.each(['openai-chat', 'openai-responses'] as const)(
        'does not send the Claude/Gemini-only budget mode to %s',
        (customFormat) => {
            const value = preset({
                customFormat,
                reasoning_effort: 'budget',
                thinking_tokens: 4096,
            })
            const result = buildPreparedRequest({
                preset: value,
                credential: { apiKey: 'secret' },
            })

            expect(result.body).not.toHaveProperty('reasoning_effort')
            expect(result.body).not.toHaveProperty('reasoning')
            expect(result.body).not.toHaveProperty('thinking_tokens')
        },
    )

    test('applies the shared Prompt JSON Schema to every Custom wire format', async () => {
        const messages = [{ role: 'user' as const, content: 'Return JSON' }]
        const structuredOutput = {
            strict: true,
            schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
                additionalProperties: false,
            },
        }
        const chat = await previewChatRequest(
            preset({ customFormat: 'openai-chat' }),
            { messages, structuredOutput },
            { apiKey: 'key' },
        )
        const responses = await previewResponsesRequest(
            preset({
                customFormat: 'openai-responses',
                endpointUrl: 'https://custom.test/v1/responses',
            }),
            { messages, structuredOutput },
            { apiKey: 'key' },
        )
        const anthropic = await previewAnthropicChatRequest(
            preset({ customFormat: 'anthropic-messages' }),
            { messages, structuredOutput },
            { apiKey: 'key' },
        )
        const gemini = await previewGoogleChatRequest(
            preset({
                customFormat: 'google-gemini',
                customAuthKind: 'query',
                endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/models/my-model:generateContent',
            }),
            { messages, structuredOutput },
            { apiKey: 'key' },
        )

        expect(chat.body.response_format).toEqual({
            type: 'json_schema',
            json_schema: { name: 'format', ...structuredOutput },
        })
        expect(responses.body.text).toEqual({
            format: { type: 'json_schema', name: 'format', ...structuredOutput },
        })
        expect(anthropic.body.output_config).toEqual({
            format: { type: 'json_schema', schema: structuredOutput.schema },
        })
        expect(gemini.body.generationConfig).toEqual({
            responseMimeType: 'application/json',
            responseJsonSchema: structuredOutput.schema,
        })
    })

    test('maps Gemini generation fields without leaking snake_case siblings', () => {
        const result = buildPreparedRequest({
            preset: preset({
                customFormat: 'google-gemini',
                customAuthKind: 'query',
                endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/models/my-model:generateContent',
                max_tokens: 4096,
                temperature: 0.5,
                top_p: 0.95,
                top_k: 64,
                frequency_penalty: 0.2,
                stopSequences: ['STOP'],
            }),
            credential: { apiKey: 'google-key' },
        })

        expect(result.url).toContain('?key=google-key')
        expect(result.body).toEqual({
            generationConfig: {
                maxOutputTokens: 4096,
                temperature: 0.5,
                topP: 0.95,
                topK: 64,
                frequencyPenalty: 0.2,
                stopSequences: ['STOP'],
            },
        })
        expect(result.body).not.toHaveProperty('top_k')
    })

    test('uses adaptive Claude thinking by default for Anthropic requests', () => {
        const result = buildPreparedRequest({
            preset: preset({
                customFormat: 'anthropic-messages',
                reasoning_effort: 'high',
            }),
            credential: { apiKey: 'key' },
        })

        expect(result.body).toMatchObject({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'high' },
        })
    })

    test('uses thinking tokens for Claude when reasoning effort is budget', () => {
        const value = preset({
            customFormat: 'anthropic-messages',
            reasoning_effort: 'budget',
            thinking_tokens: 8192,
        })
        const result = buildPreparedRequest({
            preset: value,
            credential: { apiKey: 'key' },
        })

        expect(result.body).toMatchObject({
            thinking: { type: 'enabled', budget_tokens: 8192 },
        })
        expect(result.body).not.toHaveProperty('output_config')
        expect(resolveCustomRuntimePreset(value).profileSnapshot.capabilities)
            .toContain('reasoning')
    })

    test('uses thinking tokens and includes thoughts for Gemini budget reasoning', async () => {
        const value = preset({
            customFormat: 'google-gemini',
            customAuthKind: 'query',
            endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/models/my-model:generateContent',
            reasoning_effort: 'budget',
            thinking_tokens: 4096,
        })
        const result = await previewGoogleChatRequest(
            value,
            { messages: [{ role: 'user', content: 'Hello' }] },
            { apiKey: 'google-key' },
        )

        expect(result.body).toMatchObject({
            generationConfig: {
                thinkingConfig: {
                    thinkingBudget: 4096,
                    includeThoughts: true,
                },
            },
        })
        expect(resolveCustomRuntimePreset(value).profileSnapshot.capabilities)
            .toContain('reasoning')
    })

    test('always includes thoughts for Gemini level reasoning', async () => {
        const result = await previewGoogleChatRequest(
            preset({
                customFormat: 'google-gemini',
                customAuthKind: 'query',
                endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/models/my-model:generateContent',
                reasoning_effort: 'high',
            }),
            { messages: [{ role: 'user', content: 'Hello' }] },
            { apiKey: 'google-key' },
        )

        expect(result.body).toMatchObject({
            generationConfig: {
                thinkingConfig: {
                    thinkingLevel: 'high',
                    includeThoughts: true,
                },
            },
        })
    })

    test('geminiIncludeThoughts forces thought summaries for raw Custom thinking configuration', async () => {
        const value = preset({
            customFormat: 'google-gemini',
            customAuthKind: 'query',
            endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/models/my-model:generateContent',
            reasoning_effort: 'none',
            customFlag_geminiIncludeThoughts: true,
        })
        value.additionalParamsText = 'generationConfig.thinkingConfig.thinkingBudget=2048'
        const result = await previewGoogleChatRequest(
            value,
            { messages: [{ role: 'user', content: 'Hello' }] },
            { apiKey: 'google-key' },
        )

        expect(result.body).toMatchObject({
            generationConfig: {
                thinkingConfig: {
                    thinkingBudget: 2048,
                    includeThoughts: true,
                },
            },
        })
    })

    test('keeps Claude thinking off when neither an effort nor manual mode is selected', () => {
        const value = preset({
            customFormat: 'anthropic-messages',
            reasoning_effort: 'none',
        })
        const result = buildPreparedRequest({
            preset: value,
            credential: { apiKey: 'key' },
        })

        expect(result.body).not.toHaveProperty('thinking')
        expect(result.body).not.toHaveProperty('output_config')
        expect(resolveCustomRuntimePreset(value).profileSnapshot.capabilities)
            .not.toContain('reasoning')
    })

    test('keeps a complete Gemini endpoint valid and preserves query auth', async () => {
        const value = preset({
            customFormat: 'google-gemini',
            customAuthKind: 'query',
            endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/models/my-model:generateContent',
        })
        const result = await previewGoogleChatRequest(
            value,
            { messages: [{ role: 'user', content: 'Hello' }] },
            { apiKey: 'google-key' },
        )

        expect(result.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/my-model:generateContent?key=google-key',
        )
        expect(result.body).toMatchObject({
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        })
    })

    test('builds complete adapter-native previews for the other formats', async () => {
        const messages = [
            { role: 'system' as const, content: 'System' },
            { role: 'user' as const, content: 'Hello' },
        ]
        const openAi = preset({ temperature: 0.4, max_tokens: 100 })
        const chat = await previewChatRequest(openAi, { messages }, { apiKey: 'key' })
        expect(chat.body).toMatchObject({
            model: 'my-model',
            messages,
            temperature: 0.4,
            max_tokens: 100,
            stream: false,
        })

        const responsesPreset = preset({
            customFormat: 'openai-responses',
            endpointUrl: 'https://custom.test/v1/responses',
            max_tokens: 200,
            reasoning_effort: 'high',
            verbosity: 'medium',
        })
        const responses = await previewResponsesRequest(
            responsesPreset,
            { messages },
            { apiKey: 'key' },
        )
        expect(responses.body).toMatchObject({
            model: 'my-model',
            max_output_tokens: 200,
            reasoning: { effort: 'high' },
            text: { verbosity: 'medium' },
            stream: false,
        })
        expect(responses.body).toHaveProperty('input')

        const anthropicPreset = preset({
            customFormat: 'anthropic-messages',
            customAuthKind: 'x-api-key',
            endpointUrl: 'https://custom.test/v1/messages',
            max_tokens: 300,
            frequency_penalty: 1,
            repetition_penalty: 1.2,
        })
        const anthropic = await previewAnthropicChatRequest(
            anthropicPreset,
            { messages },
            { apiKey: 'key' },
        )
        expect(anthropic.body).toMatchObject({
            model: 'my-model',
            system: 'System',
            max_tokens: 300,
            stream: false,
        })
        expect(anthropic.headers).toMatchObject({
            'x-api-key': 'key',
            'anthropic-version': '2023-06-01',
        })
        expect(anthropic.body).not.toHaveProperty('frequency_penalty')
        expect(anthropic.body).not.toHaveProperty('repetition_penalty')
    })

    test.each([
        ['moonshotai/kimi-k3', 'partial'],
        ['deepseek-ai/deepseek-v4', 'prefix'],
    ] as const)(
        'uses hasPrefill to select the %s model-specific prefill extension',
        async (modelId, extension) => {
            const result = await previewChatRequest(
                preset({ modelId, customFlag_hasPrefill: true }),
                {
                    messages: [
                        { role: 'user', content: 'Continue this' },
                        { role: 'assistant', content: 'Answer: ' },
                    ],
                },
                { apiKey: 'key' },
            )
            const messages = result.body.messages as Array<Record<string, unknown>>

            expect(messages[1]).toMatchObject({
                role: 'assistant',
                content: 'Answer: ',
                [extension]: true,
            })
        },
    )

    test('does not apply provider-specific prefill extensions when hasPrefill is off', async () => {
        const result = await previewChatRequest(
            preset({ modelId: 'deepseek-ai/deepseek-v4' }),
            {
                messages: [
                    { role: 'user', content: 'Continue this' },
                    { role: 'assistant', content: 'Answer: ' },
                ],
            },
            { apiKey: 'key' },
        )
        const messages = result.body.messages as Array<Record<string, unknown>>

        expect(messages[1]).not.toHaveProperty('prefix')
        expect(messages[1]).not.toHaveProperty('partial')
    })

    test('supports every selectable auth placement', () => {
        expect(resolvePresetAuth(preset({ customAuthKind: 'none' })).kind).toBe('none')
        expect(resolvePresetAuth(preset({ customAuthKind: 'x-api-key' })).kind).toBe('x-api-key')
        expect(resolvePresetAuth(preset({ customAuthKind: 'x-goog-api-key' })).kind).toBe('x-goog-api-key')
        expect(resolvePresetAuth(preset({ customAuthKind: 'query' })).kind).toBe('query')
    })

    test('uses ordinary ModelPreset ability fields for Custom behavior', () => {
        const stored = preset({
            customFlag_DeveloperRole: true,
            reasoning_effort: 'high',
        })
        stored.imageInput = true
        stored.foldSystemPrompt = true
        stored.keepFirstSystemPrompt = true
        stored.alternateRole = true
        stored.startWithUserInput = true
        const runtime = resolveCustomRuntimePreset(stored)

        expect(runtime).not.toBe(stored)
        expect(runtime.profileSnapshot.capabilities).toEqual([
            'streaming',
            'tools',
            'json',
            'vision',
            'reasoning',
        ])
        expect(runtime.imageInput).toBe(true)
        expect(runtime.foldSystemPrompt).toBe(true)
        expect(runtime.keepFirstSystemPrompt).toBe(true)
        expect(runtime.alternateRole).toBe(true)
        expect(runtime.startWithUserInput).toBe(true)
        expect(hasCustomFlag(runtime, 'DeveloperRole')).toBe(true)
    })
})

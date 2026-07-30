import { describe, expect, test } from 'vitest'
import type { AdapterKind, ModelPreset } from '../types'
import { compileModelPreset } from './compilePreset'

function preset(
    adapterKind: AdapterKind,
    overrides: Partial<ModelPreset> = {},
): ModelPreset {
    return {
        id: 'preset',
        name: 'Preset',
        profileSnapshot: {
            profileId: 'profile',
            providerBaseId: 'provider',
            adapterKind,
            auth: { kind: 'bearer', fields: ['apiKey'] },
            endpoint: { kind: 'static', url: 'https://example.test/v1' },
            modelId: 'model',
            schema: [{
                key: 'max_tokens',
                type: 'integer',
                label: 'Max output',
                default: 4096,
                mapsTo: { target: 'body', path: 'max_tokens' },
            }],
            uiSchema: { groups: [], fields: [] },
            defaults: {},
            capabilities: ['streaming', 'tools', 'vision'],
        },
        userValues: {},
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    }
}

describe('compileModelPreset', () => {
    test('resolves adapter, effective features, behavior, and generation once', () => {
        const source = preset('openai-compatible', {
            toolUse: true,
            foldSystemPrompt: true,
            alternateRole: true,
            userValues: { max_tokens: 8192 },
        })

        const compiled = compileModelPreset(source)

        expect(compiled.backend).toBe('http')
        expect(compiled.adapterKind).toBe('openai-compatible')
        expect(compiled.preset).toBe(source)
        expect(compiled.features).toMatchObject({
            streaming: true,
            tools: true,
            vision: true,
        })
        expect(compiled.availability).toMatchObject({
            streaming: true,
            tools: true,
            vision: true,
            jsonSchema: false,
        })
        expect(compiled.behavior).toMatchObject({
            canFoldSystemPrompt: true,
            foldSystemPrompt: true,
            alternateRole: true,
        })
        expect(compiled.generation.maxOutputTokens).toBe(8192)
    })

    test('turns the Custom profile into a request-scoped concrete adapter view', () => {
        const source = preset('custom', {
            imageInput: true,
            toolUse: true,
            userValues: {
                customFormat: 'google-gemini',
                customFlag_hasAudioInput: true,
            },
        })

        const compiled = compileModelPreset(source)

        expect(compiled.backend).toBe('http')
        expect(compiled.adapterKind).toBe('google-gemini')
        expect(compiled.sourcePreset).toBe(source)
        expect(compiled.preset).not.toBe(source)
        expect(compiled.features).toMatchObject({
            tools: true,
            vision: true,
            audioInput: true,
        })
        expect(compiled.availability.jsonSchema).toBe(true)
        expect(compiled.features.jsonSchema).toBe(false)
        expect(source.profileSnapshot.capabilities).toEqual([
            'streaming',
            'tools',
            'vision',
        ])
    })

    test('treats registry-declared image output as fixed and keeps Custom opt-in', () => {
        const fixed = compileModelPreset(preset('google-gemini', {
            profileSnapshot: {
                ...preset('google-gemini').profileSnapshot,
                capabilities: ['streaming', 'image-output'],
            },
        }))
        const custom = compileModelPreset(preset('custom', {
            userValues: {
                customFormat: 'google-gemini',
                customFlag_hasImageOutput: true,
            },
        }))

        expect(fixed.features).toMatchObject({
            imageOutput: true,
            mediaOutput: true,
        })
        expect(custom.features).toMatchObject({
            imageOutput: true,
            mediaOutput: true,
        })
    })

    test('uses the legacy streaming fallback only when capabilities are omitted', () => {
        const compileStreaming = (capabilities: ModelPreset['profileSnapshot']['capabilities']) =>
            compileModelPreset(preset('openai-compatible', {
                useStreaming: true,
                profileSnapshot: {
                    ...preset('openai-compatible').profileSnapshot,
                    capabilities,
                },
            })).features.streaming

        expect(compileStreaming(undefined)).toBe(true)
        expect(compileStreaming([])).toBe(false)
        expect(compileStreaming(['streaming'])).toBe(true)
    })

    test('gates request-scoped JSON Schema on both adapter and profile support', () => {
        const jsonPreset = preset('openai-compatible', {
            profileSnapshot: {
                ...preset('openai-compatible').profileSnapshot,
                capabilities: ['json'],
            },
        })

        const notRequested = compileModelPreset(jsonPreset)
        expect(notRequested.availability.jsonSchema).toBe(true)
        expect(notRequested.features.jsonSchema).toBe(false)

        const enabled = compileModelPreset(jsonPreset, { jsonSchemaRequested: true })
        expect(enabled.availability.jsonSchema).toBe(true)
        expect(enabled.features.jsonSchema).toBe(true)

        const undeclared = compileModelPreset(preset('openai-compatible', {
            profileSnapshot: {
                ...preset('openai-compatible').profileSnapshot,
                capabilities: [],
            },
        }), { jsonSchemaRequested: true })
        expect(undeclared.availability.jsonSchema).toBe(false)
        expect(undeclared.features.jsonSchema).toBe(false)

        const unsupportedWire = compileModelPreset(preset('amazon-bedrock', {
            profileSnapshot: {
                ...preset('amazon-bedrock').profileSnapshot,
                capabilities: ['json'],
            },
        }), { jsonSchemaRequested: true })
        expect(unsupportedWire.availability.jsonSchema).toBe(false)
        expect(unsupportedWire.features.jsonSchema).toBe(false)
    })

    test('derives system-prompt folding solely from registry policy', () => {
        expect(compileModelPreset(preset('openai-compatible', {
            foldSystemPrompt: true,
        })).behavior.foldSystemPrompt).toBe(true)
        expect(compileModelPreset(preset('openai-responses', {
            foldSystemPrompt: true,
        })).behavior.foldSystemPrompt).toBe(false)
        expect(compileModelPreset(preset('custom', {
            foldSystemPrompt: true,
            userValues: { customFormat: 'openai-responses' },
        })).behavior.foldSystemPrompt).toBe(true)
        expect(compileModelPreset(preset('anthropic-messages', {
            foldSystemPrompt: true,
        })).behavior.foldSystemPrompt).toBe(false)
    })

    test('compiles canonical generation semantics independently of field keys and wire paths', () => {
        const source = preset('amazon-bedrock', {
            profileSnapshot: {
                ...preset('amazon-bedrock').profileSnapshot,
                modelId: 'snapshot-model',
                schema: [
                    {
                        key: 'requestModel',
                        semantic: 'modelId',
                        type: 'string',
                        label: 'Model',
                        default: 'default-model',
                        mapsTo: { target: 'custom', path: 'modelId' },
                    },
                    {
                        key: 'outputCap',
                        semantic: 'maxOutputTokens',
                        type: 'integer',
                        label: 'Output',
                        mapsTo: { target: 'body', path: 'inferenceConfig.maxTokens' },
                    },
                    {
                        key: 'randomness',
                        semantic: 'temperature',
                        type: 'number',
                        label: 'Temperature',
                        mapsTo: { target: 'body', path: 'inferenceConfig.temperature' },
                    },
                ],
            },
            userValues: {
                requestModel: 'selected-model',
                outputCap: 4096,
                randomness: 0.25,
            },
        })

        const compiled = compileModelPreset(source)

        expect(compiled.modelId).toBe('selected-model')
        expect(compiled.generation).toMatchObject({
            maxOutputTokens: 4096,
            temperature: 0.25,
        })
    })

    test.each([
        ['plugin', 'plugin'],
        ['echo', 'echo'],
    ] as const)('keeps %s on its dedicated backend', (adapterKind, backend) => {
        expect(compileModelPreset(preset(adapterKind)).backend).toBe(backend)
    })

    test('compiles Plugin streaming and prompt behavior from its snapshot', () => {
        const compiled = compileModelPreset(preset('plugin', {
            useStreaming: true,
            foldSystemPrompt: true,
            profileSnapshot: {
                ...preset('plugin').profileSnapshot,
                capabilities: ['streaming'],
            },
        }))

        expect(compiled.backend).toBe('plugin')
        expect(compiled.availability.streaming).toBe(true)
        expect(compiled.features.streaming).toBe(true)
        expect(compiled.behavior).toMatchObject({
            canFoldSystemPrompt: true,
            foldSystemPrompt: true,
        })
    })
})

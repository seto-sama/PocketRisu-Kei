import { describe, expect, it } from 'vitest'
import type { AdapterKind } from '../types'
import {
    MODEL_PRESET_ADAPTER_REGISTRY,
    getModelPresetAdapterDefinition,
    isHttpAdapterKind,
} from './registry'

describe('model preset adapter registry', () => {
    it('contains every concrete HTTP adapter with dispatch and support metadata', () => {
        expect(Object.keys(MODEL_PRESET_ADAPTER_REGISTRY)).toEqual([
            'openai-compatible',
            'openai-responses',
            'anthropic-messages',
            'google-gemini',
            'amazon-bedrock',
        ])

        for (const [kind, definition] of Object.entries(MODEL_PRESET_ADAPTER_REGISTRY)) {
            expect(definition.kind).toBe(kind)
            expect(definition.support).toMatchObject({
                streaming: true,
                tools: true,
                vision: true,
            })
            expect(definition.send).toBeTypeOf('function')
            expect(definition.stream).toBeTypeOf('function')
            expect(definition.preview).toBeTypeOf('function')
        }
    })

    it.each<AdapterKind>(['custom', 'plugin', 'echo'])(
        'leaves the %s dispatch-only kind outside the HTTP registry',
        (kind) => {
            expect(getModelPresetAdapterDefinition(kind)).toBeUndefined()
            expect(isHttpAdapterKind(kind)).toBe(false)
        },
    )

    it('returns the registered definition and narrows concrete kinds', () => {
        const kind: AdapterKind = 'google-gemini'
        expect(isHttpAdapterKind(kind)).toBe(true)
        expect(getModelPresetAdapterDefinition(kind)?.kind).toBe('google-gemini')
    })

    it('describes the system-prompt folding policy once', () => {
        expect(getModelPresetAdapterDefinition('openai-compatible').support)
            .toMatchObject({
                systemPromptFolding: 'always',
            })
        expect(getModelPresetAdapterDefinition('openai-responses').support)
            .toMatchObject({
                systemPromptFolding: 'custom-only',
            })
        for (const kind of [
            'anthropic-messages',
            'google-gemini',
            'amazon-bedrock',
        ] as const) {
            expect(getModelPresetAdapterDefinition(kind).support)
                .toMatchObject({
                    systemPromptFolding: 'never',
                })
        }
    })

    it('declares JSON Schema wire support explicitly', () => {
        for (const kind of [
            'openai-compatible',
            'openai-responses',
            'anthropic-messages',
            'google-gemini',
        ] as const) {
            expect(getModelPresetAdapterDefinition(kind).support.jsonSchema).toBe(true)
        }
        expect(getModelPresetAdapterDefinition('amazon-bedrock').support.jsonSchema)
            .toBe(false)
    })
})

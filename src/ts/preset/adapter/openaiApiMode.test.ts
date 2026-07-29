import { describe, expect, test } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import {
    applyOpenAiApiModeEndpoint,
    normalizeOpenAiResponsesBodyForMode,
    OPENAI_API_MODE_KEY,
    resolveModelPresetAdapterKind,
} from './openaiApiMode'

function preset(
    mode: 'completions' | 'responses' | undefined,
    withSelector = true,
): ModelPreset {
    const snapshot: ResolvedModelProfileSnapshot = {
        profileId: 'gateway:openai/gpt-5',
        providerBaseId: 'gateway',
        adapterKind: 'openai-compatible',
        auth: { kind: 'bearer', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://gateway.test/v1/chat/completions' },
        modelId: 'openai/gpt-5',
        schema: withSelector ? [{
            key: OPENAI_API_MODE_KEY,
            type: 'string',
            label: 'API Mode',
            default: 'completions',
            enum: [
                { value: 'completions', label: 'Chat Completions' },
                { value: 'responses', label: 'Responses' },
            ],
            mapsTo: { target: 'custom', path: OPENAI_API_MODE_KEY },
        }] : [],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
    }
    return {
        id: 'preset',
        name: 'GPT',
        profileSnapshot: snapshot,
        userValues: mode ? { [OPENAI_API_MODE_KEY]: mode } : {},
        createdAt: 0,
        updatedAt: 0,
    }
}

describe('OpenAI API mode', () => {
    test('defaults generated GPT selectors to Chat Completions', () => {
        expect(resolveModelPresetAdapterKind(preset(undefined))).toBe('openai-compatible')
    })

    test('selects the Responses adapter and endpoint', () => {
        const selected = preset('responses')
        const prepared = {
            method: 'POST' as const,
            url: selected.profileSnapshot.endpoint.url,
            headers: {},
            body: {},
        }

        applyOpenAiApiModeEndpoint(selected, prepared)

        expect(resolveModelPresetAdapterKind(selected)).toBe('openai-responses')
        expect(prepared.url).toBe('https://gateway.test/v1/responses')
    })

    test('translates Chat Completions generation fields for Responses', () => {
        const body: Record<string, unknown> = {
            max_completion_tokens: 4096,
            reasoning_effort: 'high',
            verbosity: 'medium',
        }

        normalizeOpenAiResponsesBodyForMode(preset('responses'), body)

        expect(body).toEqual({
            max_output_tokens: 4096,
            reasoning: { effort: 'high' },
            text: { verbosity: 'medium' },
        })
    })

    test('leaves profiles without the generated selector unchanged', () => {
        const legacy = preset('responses', false)
        const prepared = {
            method: 'POST' as const,
            url: legacy.profileSnapshot.endpoint.url,
            headers: {},
            body: {},
        }

        applyOpenAiApiModeEndpoint(legacy, prepared)

        expect(resolveModelPresetAdapterKind(legacy)).toBe('openai-compatible')
        expect(prepared.url).toBe('https://gateway.test/v1/chat/completions')
    })
})

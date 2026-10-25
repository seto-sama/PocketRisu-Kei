import { describe, expect, test } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { ModelPresetAdapterError } from './error'
import { resolveWireModelId } from './wireInvariants'

function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:standard',
        providerBaseId: 'demo',
        adapterKind: 'openai-compatible',
        auth: { kind: 'bearer', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1' },
        modelId: '',
        schema: [
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        capabilities: [],
        ...overrides,
    }
}

function makePreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset-1',
        name: 'Demo',
        profileSnapshot: makeSnapshot(),
        userValues: {},
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    }
}

describe('resolveWireModelId', () => {
    test('returns the userValues.modelId when present and non-empty', () => {
        const preset = makePreset({ userValues: { modelId: 'gpt-5' } })
        expect(resolveWireModelId(preset)).toBe('gpt-5')
    })

    test('normalizes a Cloudflare catalog model at the shared wire boundary', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'cloudflare-ai', path: 'messages' },
                modelId: 'anthropic/claude-opus-4-6',
            }),
        })

        expect(resolveWireModelId(preset)).toBe('anthropic/claude-opus-4.6')
    })

    test.each([
        ['an empty string', ''],
        ['null', null],
        ['a non-string value', 42],
    ])('throws instead of falling back when userValues.modelId is %s', (_label, modelId) => {
        const preset = makePreset({
            userValues: { modelId: modelId as unknown as string },
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'modelId',
                        type: 'string',
                        label: 'Model ID',
                        default: 'fallback-model',
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
                modelId: 'snapshot-model',
            }),
        })
        expect(() => resolveWireModelId(preset)).toThrowError(ModelPresetAdapterError)
    })

    test('falls back to schema field default when userValues lacks the modelId key', () => {
        const preset = makePreset({
            userValues: {},
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'modelId',
                        type: 'string',
                        label: 'Model ID',
                        default: 'fallback-model',
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
            }),
        })
        expect(resolveWireModelId(preset)).toBe('fallback-model')
    })

    test('falls back to snapshot.modelId when neither userValues nor schema default provide one', () => {
        const preset = makePreset({
            userValues: {},
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'modelId',
                        type: 'string',
                        label: 'Model ID',
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
                modelId: 'snapshot-model',
            }),
        })
        expect(resolveWireModelId(preset)).toBe('snapshot-model')
    })

    test('throws invalid-request with vendor name when no source provides a modelId', () => {
        const preset = makePreset({
            userValues: {},
            profileSnapshot: makeSnapshot({ schema: [], modelId: '' }),
        })
        expect(() => resolveWireModelId(preset, { vendorName: 'Google Gemini' })).toThrowError(
            expect.objectContaining({
                kind: 'invalid-request',
                retryable: false,
                message: expect.stringContaining('Google Gemini'),
            }),
        )
    })
})

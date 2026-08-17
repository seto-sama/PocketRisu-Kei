import { describe, expect, test, beforeEach, vi } from 'vitest'

// Mock the database module so resolveChatModelBinding reads a controllable db.
// Only getDatabase is imported at runtime by modelPresetBinding.ts (everything
// else there is type-only), so a minimal factory keeps us off the big import graph.
let mockDb: any
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb,
}))

import {
    resolveChatModelBinding,
    resolvePresetMaxOutputTokens,
    resolveChatMaxResponseTokens,
    applyPromptPresetParams,
} from './modelPresetBinding'
import { emptyModelBinding } from 'src/ts/preset/types'

const PRESET = { id: 'p-main', name: 'Main' } as any

function bindingWith(main?: string) {
    const b = emptyModelBinding()
    if (main !== undefined) b.main = main
    return b
}

beforeEach(() => {
    mockDb = {
        modelPresets: [PRESET],
        defaultModelBinding: undefined,
    }
})

describe('resolveChatModelBinding — model-preset-only mode', () => {
    test('resolves the chat binding regardless of its legacy mode value', () => {
        const chat = { useModelPreset: true, modelBinding: bindingWith('p-main') } as any
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'modelPreset', preset: PRESET })
        chat.useModelPreset = false
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'modelPreset', preset: PRESET })
    })

    test('an old chat without a binding resolves through the global default', () => {
        // Both removed global settings may still be present in imported data;
        // neither is allowed to affect runtime resolution.
        mockDb.nodeOnlyModelModeLock = 'legacy'
        mockDb.useModelPresetByDefault = false
        mockDb.defaultModelBinding = bindingWith('p-main')
        const chat = { useModelPreset: false, modelBinding: undefined } as any
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'modelPreset', preset: PRESET })
    })

    test('blocks when neither the chat nor the global default has a binding', () => {
        const chat = { useModelPreset: false, modelBinding: undefined } as any
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'block', reason: 'main-unset' })
    })
})

describe('resolveChatModelBinding — per-module override', () => {
    const MODULE_PRESET = { id: 'p-module', name: 'Module' } as any
    const chat = { modelBinding: bindingWith('p-main') } as any

    beforeEach(() => {
        mockDb.modelPresets = [PRESET, MODULE_PRESET]
        mockDb.moduleModelBindings = { 'module-1': 'p-module' }
    })

    test('uses the preset assigned to the requesting module', () => {
        expect(resolveChatModelBinding(chat, 'model', 'module-1'))
            .toEqual({ kind: 'modelPreset', preset: MODULE_PRESET })
    })

    test('falls through when the assigned preset was deleted', () => {
        mockDb.moduleModelBindings = { 'module-1': 'missing' }
        expect(resolveChatModelBinding(chat, 'model', 'module-1'))
            .toEqual({ kind: 'modelPreset', preset: PRESET })
    })

    test('does not affect requests without a module owner', () => {
        expect(resolveChatModelBinding(chat, 'model'))
            .toEqual({ kind: 'modelPreset', preset: PRESET })
    })
})

function presetWith(opts: { schema?: any[]; userValues?: any; defaults?: any } = {}) {
    return {
        id: 'p-main',
        name: 'Main',
        profileSnapshot: { schema: opts.schema ?? [], defaults: opts.defaults },
        userValues: opts.userValues ?? {},
    } as any
}

describe('resolvePresetMaxOutputTokens — output cap comes from the preset, not db.maxResponse', () => {
    test('reads the userValue of the field that maps to body.max_tokens', () => {
        const preset = presetWith({
            schema: [{ key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } }],
            userValues: { max_tokens: 8192 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(8192)
    })

    test('falls back to the schema default when the user left the field unset', () => {
        const preset = presetWith({
            schema: [{ key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } }],
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(4096)
    })

    test('matches Gemini-native maxOutputTokens via its nested body path', () => {
        const preset = presetWith({
            schema: [{ key: 'maxOutputTokens', mapsTo: { target: 'body', path: 'generationConfig.maxOutputTokens' } }],
            userValues: { maxOutputTokens: 2048 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(2048)
    })

    test('uses semantic metadata for Bedrock inferenceConfig.maxTokens', () => {
        const preset = presetWith({
            schema: [{
                key: 'outputCap',
                semantic: 'maxOutputTokens',
                mapsTo: { target: 'body', path: 'inferenceConfig.maxTokens' },
            }],
            defaults: { inferenceConfig: { maxTokens: 3072 } },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(3072)
    })

    test('keeps legacy Bedrock maxTokens snapshots working without semantic metadata', () => {
        const preset = presetWith({
            schema: [{
                key: 'maxTokens',
                mapsTo: { target: 'body', path: 'inferenceConfig.maxTokens' },
            }],
            userValues: { maxTokens: 6144 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(6144)
    })

    test('treats declared semantic metadata as authoritative over a legacy-looking key', () => {
        const preset = presetWith({
            schema: [{
                key: 'max_tokens',
                semantic: 'temperature',
                mapsTo: { target: 'body', path: 'temperature' },
            }],
            userValues: { max_tokens: 4096 },
            defaults: { max_tokens: 2048 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBeUndefined()
    })

    test('returns undefined when no output-token field is declared', () => {
        const preset = presetWith({
            schema: [{ key: 'temperature', mapsTo: { target: 'body', path: 'temperature' } }],
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBeUndefined()
    })

    test('ignores a non-positive or non-numeric value (falls through to undefined)', () => {
        const preset = presetWith({
            schema: [{ key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } }],
            userValues: { max_tokens: 0 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBeUndefined()
    })

    test('legacy snapshot: schema has no output field but defaults carries it (Anthropic 4096)', () => {
        // An Anthropic preset snapshotted before the schema gained max_tokens —
        // the cap lives only in profileSnapshot.defaults.
        const preset = presetWith({
            schema: [{ key: 'apiKey', mapsTo: { target: 'auth', path: 'apiKey' } }],
            defaults: { max_tokens: 4096 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(4096)
    })

    test('schema output field with no default/userValue falls through to defaults', () => {
        const preset = presetWith({
            schema: [{ key: 'max_tokens', mapsTo: { target: 'body', path: 'max_tokens' } }],
            defaults: { max_tokens: 8192 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(8192)
    })

    test('defaults fallback resolves a nested Gemini path declared by the schema', () => {
        const preset = presetWith({
            schema: [{ key: 'maxOutputTokens', mapsTo: { target: 'body', path: 'generationConfig.maxOutputTokens' } }],
            defaults: { generationConfig: { maxOutputTokens: 2048 } },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(2048)
    })

    test('user-set value still wins over defaults', () => {
        const preset = presetWith({
            schema: [{ key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } }],
            userValues: { max_tokens: 16000 },
            defaults: { max_tokens: 4096 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(16000)
    })
})

describe('resolveChatMaxResponseTokens — the bug: stray legacy db.maxResponse must not leak into preset budgeting', () => {
    test('an unresolved binding falls back to the global db.maxResponse', () => {
        mockDb.maxResponse = 300
        const chat = { useModelPreset: false, modelBinding: undefined } as any
        expect(resolveChatMaxResponseTokens(chat)).toBe(300)
    })

    test('preset chat uses the preset output cap, NOT the stray legacy db.maxResponse (65535)', () => {
        // db.maxResponse carries a high value imported from a shared prompt
        // preset; the budget must ignore it and reserve the preset's 8192.
        mockDb.maxResponse = 65535
        mockDb.modelPresets = [presetWith({
            schema: [{ key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } }],
            userValues: { max_tokens: 8192 },
        })]
        const chat = { useModelPreset: true, modelBinding: bindingWith('p-main') } as any
        expect(resolveChatMaxResponseTokens(chat)).toBe(8192)
    })

    test('preset with no output-token field falls back to db.maxResponse', () => {
        mockDb.maxResponse = 500
        mockDb.modelPresets = [presetWith()]
        const chat = { useModelPreset: true, modelBinding: bindingWith('p-main') } as any
        expect(resolveChatMaxResponseTokens(chat)).toBe(500)
    })
})

describe('applyPromptPresetParams — prompt-preset sampling override', () => {
    const SAMPLING_SCHEMA = [
        { key: 'temperature', default: 0.7, mapsTo: { target: 'body', path: 'temperature' } },
        { key: 'top_p', default: 1, mapsTo: { target: 'body', path: 'top_p' } },
        { key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } },
    ]

    beforeEach(() => {
        // Classic prompt-preset params as mirrored into db.* by setPreset
        // (temperature / penalties are stored in hundredths).
        mockDb.temperature = 80
        mockDb.top_p = 0.9
        mockDb.top_k = 40
        mockDb.frequencyPenalty = 50
        mockDb.PresensePenalty = -1000 // slider disabled
        mockDb.maxResponse = 65535
    })

    const onChat = { usePromptPresetParams: true } as any

    test('identity when the chat did not opt in', () => {
        const preset = presetWith({ schema: SAMPLING_SCHEMA })
        expect(applyPromptPresetParams(preset, { usePromptPresetParams: false } as any, 'model')).toBe(preset)
        expect(applyPromptPresetParams(preset, {} as any, 'model')).toBe(preset)
        expect(applyPromptPresetParams(preset, undefined, 'model')).toBe(preset)
    })

    test('global preference overrides the per-chat opt-in', () => {
        mockDb.modelPresetPromptParamsFirst = true
        const preset = presetWith({
            schema: SAMPLING_SCHEMA,
            userValues: { temperature: 0.2 },
        })
        const out = applyPromptPresetParams(preset, { usePromptPresetParams: false } as any, 'model')
        expect(out.userValues.temperature).toBe(0.8)
        expect(out.userValues.top_p).toBe(0.9)
    })

    test('identity for non-main modes even when opted in', () => {
        const preset = presetWith({ schema: SAMPLING_SCHEMA })
        expect(applyPromptPresetParams(preset, onChat, 'submodel')).toBe(preset)
        expect(applyPromptPresetParams(preset, onChat, 'memory')).toBe(preset)
    })

    test('global prompt-parameter priority is also limited to the main model', () => {
        mockDb.modelPresetPromptParamsFirst = true
        const preset = presetWith({ schema: SAMPLING_SCHEMA })
        expect(applyPromptPresetParams(preset, onChat, 'submodel')).toBe(preset)
        expect(applyPromptPresetParams(preset, onChat, 'memory')).toBe(preset)
        expect(applyPromptPresetParams(preset, onChat, 'emotion')).toBe(preset)
        expect(applyPromptPresetParams(preset, onChat, 'translate')).toBe(preset)
    })

    test('injects normalized sampling values over userValues without mutating the stored preset', () => {
        const preset = presetWith({
            schema: SAMPLING_SCHEMA,
            userValues: { temperature: 0.2, apiKey: 'k' },
        })
        const out = applyPromptPresetParams(preset, onChat, 'model')
        expect(out).not.toBe(preset)
        expect(out.userValues.temperature).toBe(0.8) // 80 hundredths -> 0.8, beats the editor's 0.2
        expect(out.userValues.top_p).toBe(0.9)
        expect(out.userValues.apiKey).toBe('k') // unrelated values preserved
        expect(preset.userValues).toEqual({ temperature: 0.2, apiKey: 'k' }) // input untouched
    })

    test('schema-gated: params the profile does not declare are not injected (top_k), and output caps never are', () => {
        const preset = presetWith({ schema: SAMPLING_SCHEMA })
        const out = applyPromptPresetParams(preset, onChat, 'model')
        expect(out.userValues).not.toHaveProperty('top_k') // db.top_k=40 but schema lacks it
        expect(out.userValues).not.toHaveProperty('max_tokens') // sampling only, never the output cap
    })

    test('-1000 slider-disabled sentinel is treated as unset', () => {
        const preset = presetWith({
            schema: [
                { key: 'presence_penalty', mapsTo: { target: 'body', path: 'presence_penalty' } },
                { key: 'frequency_penalty', mapsTo: { target: 'body', path: 'frequency_penalty' } },
            ],
        })
        const out = applyPromptPresetParams(preset, onChat, 'model')
        expect(out.userValues).not.toHaveProperty('presence_penalty') // PresensePenalty = -1000
        expect(out.userValues.frequency_penalty).toBe(0.5) // 50 hundredths -> 0.5
    })

    test('wire-flavored alias keys map to the same classic values (Gemini camelCase)', () => {
        const preset = presetWith({
            schema: [
                { key: 'topP', mapsTo: { target: 'body', path: 'generationConfig.topP' } },
                { key: 'topK', mapsTo: { target: 'body', path: 'generationConfig.topK' } },
            ],
        })
        const out = applyPromptPresetParams(preset, onChat, 'model')
        expect(out.userValues.topP).toBe(0.9)
        expect(out.userValues.topK).toBe(40)
    })

    test('canonical temperature semantic works independently of a custom storage key', () => {
        const preset = presetWith({
            schema: [{
                key: 'randomness',
                semantic: 'temperature',
                mapsTo: { target: 'custom', path: 'generation.temperature' },
            }],
        })
        const out = applyPromptPresetParams(preset, onChat, 'model')
        expect(out.userValues.randomness).toBe(0.8)
    })

    test('canonical output semantic applies prompt output priority on custom mappings', () => {
        mockDb.modelPresetPromptPresetFirst = true
        const preset = presetWith({
            schema: [{
                key: 'outputCap',
                semantic: 'maxOutputTokens',
                mapsTo: { target: 'custom', path: 'generation.maxTokens' },
            }],
        })
        const out = applyPromptPresetParams(preset, onChat, 'model')
        expect(out.userValues.outputCap).toBe(65535)
    })

    test('non-body mappings are ignored even if the key matches', () => {
        const preset = presetWith({
            schema: [{ key: 'temperature', mapsTo: { target: 'header', path: 'X-Temp' } }],
        })
        expect(applyPromptPresetParams(preset, onChat, 'model')).toBe(preset)
    })

    test('identity when nothing in the schema matches', () => {
        const preset = presetWith({
            schema: [{ key: 'apiKey', mapsTo: { target: 'auth', path: 'apiKey' } }],
        })
        expect(applyPromptPresetParams(preset, onChat, 'model')).toBe(preset)
    })
})

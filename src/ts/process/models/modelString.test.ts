import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ModelPreset } from 'src/ts/preset/types'

let mockDb: any
let mockChat: any
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb,
    getCurrentChat: () => mockChat,
}))

import {
    getGenerationModelMetadata,
    getGenerationModelString,
    getModelPresetTokenizer,
} from './modelString'

function preset(id: string, name: string, modelId: string): ModelPreset {
    return {
        id,
        name,
        profileSnapshot: {
            profileId: 'profile',
            providerBaseId: 'openai',
            adapterKind: 'openai-compatible',
            auth: { kind: 'bearer', fields: ['apiKey'] },
            endpoint: { kind: 'static', url: 'https://example.test/v1' },
            modelId,
            schema: [{
                key: 'modelId',
                type: 'string',
                label: 'Model',
                semantic: 'modelId',
            }],
            uiSchema: { groups: [], fields: [] },
            defaults: {},
            capabilities: ['streaming', 'vision'],
            recommendedTokenizer: 'tik',
        },
        userValues: {},
        createdAt: 1,
        updatedAt: 1,
    }
}

beforeEach(() => {
    const main = preset('main', 'Main Preset', 'gpt-default')
    main.userValues.modelId = 'gpt-effective'
    main.tokenizerOverride = 'llama'
    const sub = preset('sub', 'Sub Preset', 'gpt-sub')
    mockDb = {
        modelPresets: [main, sub],
        defaultModelBinding: undefined,
    }
    mockChat = {
        modelBinding: {
            main: 'main',
            sub: 'sub',
            separateAux: false,
            aux: {},
        },
    }
})

describe('model preset generation metadata', () => {
    test('resolves display name, effective model ID, capabilities, and tokenizer', () => {
        expect(getGenerationModelString()).toBe('Main Preset')
        expect(getGenerationModelMetadata('model')).toMatchObject({
            presetId: 'main',
            name: 'Main Preset',
            shortName: 'Main Preset',
            internalId: 'gpt-effective',
            format: 'openai-compatible',
            provider: 'openai',
            tokenizer: 'llama',
            streaming: true,
            vision: true,
        })
        expect(getGenerationModelMetadata('submodel').name).toBe('Sub Preset')
    })

    test('uses adapter defaults only when the preset declares no tokenizer', () => {
        const gemini = preset('gemini', 'Gemini', 'gemini-model')
        gemini.profileSnapshot.adapterKind = 'google-gemini'
        gemini.profileSnapshot.recommendedTokenizer = undefined
        expect(getModelPresetTokenizer(gemini)).toBe('gemma')
    })

    test('returns empty metadata when the binding is unset', () => {
        mockChat.modelBinding.main = ''
        expect(getGenerationModelString()).toBe('')
        expect(getGenerationModelMetadata('model')).toMatchObject({
            name: '',
            internalId: '',
            tokenizer: 'tik',
            vision: false,
        })
    })
})

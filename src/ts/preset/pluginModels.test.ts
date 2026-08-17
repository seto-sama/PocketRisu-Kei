import { describe, expect, test } from 'vitest'
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from '../model/types'
import {
    buildPluginRegistry,
    listPluginModels,
    PLUGIN_PROVIDER_BASE_ID,
    PLUGIN_REGISTRY_ID,
    pluginArgumentValues,
    pluginProfileDisplayId,
    pluginPresetAbilityDefaults,
} from './pluginModels'

function metadata(name: string): LLMModel {
    return {
        id: `pluginmodel:::${name}`,
        name: `Pretty ${name}`,
        provider: LLMProvider.AsIs,
        format: LLMFormat.Plugin,
        flags: [LLMFlags.hasStreaming, LLMFlags.requiresAlternateRole],
        parameters: ['temperature', 'top_p'],
        tokenizer: LLMTokenizer.Gemma,
    }
}

describe('plugin model presets', () => {
    test('builds entries only from API 3.0 metadata', () => {
        expect(listPluginModels([])).toEqual([])
        const models = listPluginModels([metadata('managed')])
        expect(models.map((model) => model.providerName)).toEqual(['managed'])
        expect(models[0].displayName).toBe('Pretty managed')
    })

    test('builds transient Developer profiles for API 3.0 providers', () => {
        const managedMetadata = metadata('managed')
        managedMetadata.parameters = ['temperature', 'top_p', 'top_k']
        const definitions = listPluginModels([managedMetadata])
        const registry = buildPluginRegistry(definitions, 'Plugin model')
        const entry = registry.registries[PLUGIN_REGISTRY_ID]
        const base = entry.baseProviders?.[PLUGIN_PROVIDER_BASE_ID]
        const profiles = Object.values(entry.profiles ?? {})

        expect(base?.adapterKind).toBe('plugin')
        expect(base?.providerGroupId).toBe('plugin')
        expect(base?.providerGroupDisplayName).toBe('Plugin')
        expect(profiles).toHaveLength(1)

        const managed = profiles.find((profile) => profile.modelId === 'pluginmodel:::managed')!
        expect(managed.schema.map((field) => field.key)).toEqual(['max_tokens', 'temperature', 'top_p', 'top_k'])
        expect(managed.recommendedTokenizer).toBe('gemma')
        const topK = managed.schema.find((field) => field.key === 'top_k')
        const topKUi = managed.uiSchema.fields.find((field) => field.key === 'top_k')
        expect(topK).toMatchObject({ min: 0, max: 500, step: 1 })
        expect(topK?.default).toBeUndefined()
        expect(managed.defaults).not.toHaveProperty('top_k')
        expect(topKUi).toMatchObject({
            widget: 'slider',
            visibility: 'basic',
            layout: 'row',
            disableable: true,
            group: 'generation',
        })
        expect(managed.uiSchema.fields.find(field => field.key === 'max_tokens'))
            .toMatchObject({ widget: 'slider', visibility: 'basic', order: 1 })
    })

    test('stores raw profile IDs and only escapes the plugin URI', () => {
        const providerName = '[PM] gemini model'
        const registry = buildPluginRegistry(listPluginModels([metadata(providerName)]), 'Plugin model')
        const profiles = registry.registries[PLUGIN_REGISTRY_ID].profiles ?? {}
        const profile = profiles[`plugin:${providerName}`]

        expect(profile?.id).toBe(`plugin:${providerName}`)
        expect(profile?.modelId).toBe(`pluginmodel:::${providerName}`)
        expect(profile?.endpoint).toEqual({
            kind: 'static',
            url: 'plugin://%5BPM%5D%20gemini%20model',
        })
    })

    test('resolves saved values over profile defaults and derives model abilities', () => {
        const registry = buildPluginRegistry(listPluginModels([metadata('managed')]), 'Plugin model')
        const profile = Object.values(registry.registries[PLUGIN_REGISTRY_ID].profiles ?? {})[0]

        expect(pluginArgumentValues(profile, { temperature: 0.25 })).toMatchObject({
            max_tokens: 4096,
            temperature: 0.25,
            top_p: 1,
        })
        expect(pluginPresetAbilityDefaults('pluginmodel:::managed', [metadata('managed')])).toEqual({
            foldSystemPrompt: true,
            keepFirstSystemPrompt: false,
            alternateRole: true,
            startWithUserInput: false,
        })
    })

    test('shows the original provider name instead of the profile ID', () => {
        const modelId = 'pluginmodel:::[PM] gemini-3.5-flash-lite (Vertex AI)'
        expect(pluginProfileDisplayId(modelId)).toBe(
            'Plugin / [PM] gemini-3.5-flash-lite (Vertex AI)',
        )
    })
})

import { describe, expect, test } from 'vitest'
import type {
    BaseProviderDefinition,
    ModelProfile,
    RegistryCache,
} from '../types'
import {
    DEFAULT_VISIBLE_PROVIDER_IDS,
    isProfileProviderVisible,
    listFilterableProviderGroups,
    resolveProviderFilterHiddenIds,
    resolveProviderFilterVisibleIds,
} from './providerFilter'

function base(
    id: string,
    displayName: string,
    extra: Partial<BaseProviderDefinition> = {},
): BaseProviderDefinition {
    return {
        id,
        displayName,
        adapterKind: 'openai-compatible',
        authKinds: ['bearer'],
        endpointKinds: ['static'],
        requestSchema: [],
        uiSchema: { groups: [], fields: [] },
        sourceUrls: [],
        ...extra,
    }
}

function profile(id: string, providerBaseId: string): ModelProfile {
    return {
        id,
        displayName: id,
        providerBaseId,
        profileStatus: 'current',
        modelId: id,
        endpoint: { kind: 'static', url: 'https://example.test/v1' },
        auth: { kind: 'bearer', fields: [] },
        defaults: {},
        schema: [],
        uiSchema: { groups: [], fields: [] },
        sourceUrls: [],
    }
}

function registry(): RegistryCache {
    return {
        schemaVersion: 4,
        registries: {
            official: {
                fetchedAt: 1,
                baseProviders: {
                    'alpha-chat': base('alpha-chat', 'Alpha Chat', {
                        providerGroupId: 'alpha',
                        providerGroupDisplayName: 'Alpha',
                    }),
                    'alpha-responses': base('alpha-responses', 'Alpha Responses', {
                        providerGroupId: 'alpha',
                        providerGroupDisplayName: 'Alpha',
                    }),
                    beta: base('beta', 'Beta'),
                    developer: base('developer', 'Developer', { adapterKind: 'echo' }),
                },
                profiles: {
                    'alpha:one': profile('alpha:one', 'alpha-chat'),
                    'alpha:two': profile('alpha:two', 'alpha-responses'),
                    'beta:one': profile('beta:one', 'beta'),
                    'developer:echo': profile('developer:echo', 'developer'),
                },
            },
        },
    }
}

describe('provider filter', () => {
    test('starts with only the curated provider set visible', () => {
        const all = [
            ...DEFAULT_VISIBLE_PROVIDER_IDS,
            'amazon-bedrock',
            'another-provider',
            'new-provider',
        ]
        const hidden = resolveProviderFilterHiddenIds(all, undefined, false)

        expect([...DEFAULT_VISIBLE_PROVIDER_IDS].sort()).toEqual([
            'anthropic',
            'deepseek',
            'google',
            'google-vertex',
            'llmgateway',
            'nanogpt',
            'neuralwatt',
            'ollama-cloud',
            'openai',
            'openrouter',
            'vercel',
        ])
        expect(hidden).toEqual(new Set([
            'amazon-bedrock',
            'another-provider',
            'new-provider',
        ]))
    })

    test('migrates an initialized empty legacy hidden list as show all', () => {
        expect(resolveProviderFilterHiddenIds(['openai', 'other'], undefined, true, []))
            .toEqual(new Set())
    })

    test('starts providers added after initialization hidden', () => {
        expect(resolveProviderFilterHiddenIds(
            ['openai', 'existing-provider', 'new-provider'],
            ['openai', 'existing-provider'],
            true,
        )).toEqual(new Set(['new-provider']))
    })

    test('converts the legacy hidden list into a visible allowlist', () => {
        expect(resolveProviderFilterVisibleIds(
            ['openai', 'existing-provider'],
            undefined,
            true,
            ['existing-provider'],
        )).toEqual(new Set(['openai']))
    })

    test('retains visible providers that temporarily disappear', () => {
        expect(resolveProviderFilterVisibleIds(
            ['existing-provider', 'new-provider'],
            ['existing-provider', 'removed-provider'],
            true,
        )).toEqual(new Set(['existing-provider', 'removed-provider']))
    })

    test('lists provider groups once and excludes the always-visible Echo provider', () => {
        expect(listFilterableProviderGroups(registry(), 'official')).toEqual([
            { id: 'alpha', label: 'Alpha', profileCount: 2 },
            { id: 'beta', label: 'Beta', profileCount: 1 },
        ])
    })

    test('hides selected provider groups but never hides Echo', () => {
        const entry = registry().registries.official!
        const hidden = new Set(['alpha', 'developer'])

        expect(isProfileProviderVisible(
            entry.profiles!['alpha:one'],
            entry.baseProviders!['alpha-chat'],
            hidden,
        )).toBe(false)
        expect(isProfileProviderVisible(
            entry.profiles!['beta:one'],
            entry.baseProviders!.beta,
            hidden,
        )).toBe(true)
        expect(isProfileProviderVisible(
            entry.profiles!['developer:echo'],
            entry.baseProviders!.developer,
            hidden,
        )).toBe(true)
    })
})

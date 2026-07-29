import { describe, expect, test } from 'vitest'
import type { BaseProviderDefinition, ModelProfile, RegistryCache } from '../types'
import { getOfficialRegistryId, loadSpecialRegistry } from './loader'
import {
    RegistryBaseProviderNotFoundError,
    RegistryProfileNotFoundError,
    resolveSnapshot,
} from './snapshot'

describe('resolveSnapshot', () => {
    test('resolves the built-in Echo recipe', () => {
        const snapshot = resolveSnapshot(loadSpecialRegistry(), 'developer:echo')
        expect(snapshot.adapterKind).toBe('echo')
        expect(snapshot.auth.kind).toBe('none')
        expect(snapshot.endpoint.url).toBe('local://echo')
    })

    test('resolves the built-in Custom recipe in the Developer group', () => {
        const registry = loadSpecialRegistry()
        const snapshot = resolveSnapshot(registry, 'developer:custom')
        const base = registry.registries[getOfficialRegistryId()]?.baseProviders?.['developer-custom']

        expect(snapshot.adapterKind).toBe('custom')
        expect(snapshot.endpoint.url).toBe('')
        expect(snapshot.schema.some(field => field.key === 'endpointUrl')).toBe(true)
        expect(snapshot.schema.some(field => field.key === 'customFlag_DeveloperRole')).toBe(true)
        expect(base?.displayName).toBe('Developer')
        expect(base?.providerGroupId).toBe('developer')
        expect(base?.providerGroupDisplayName).toBe('Developer')
    })

    test('merges base/profile fields and backfills modelId defaults', () => {
        const base: BaseProviderDefinition = {
            id: 'demo',
            displayName: 'Demo',
            adapterKind: 'openai-compatible',
            authKinds: ['bearer'],
            endpointKinds: ['static'],
            defaultHeaders: { A: 'base' },
            requestSchema: [{
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                mapsTo: { target: 'auth', path: 'apiKey' },
            }, {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                mapsTo: { target: 'body', path: 'model' },
            }],
            uiSchema: {
                groups: [{ id: 'base', label: 'Base' }],
                fields: [{ key: 'apiKey', widget: 'secret', visibility: 'basic' }],
            },
            limits: { known: false, contextWindowTokens: 65536 },
            sourceUrls: [],
        }
        const profile: ModelProfile = {
            id: 'demo:model',
            displayName: 'Model',
            providerBaseId: 'demo',
            profileStatus: 'current',
            modelId: 'model-v1',
            endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
            auth: { kind: 'bearer', fields: ['apiKey'] },
            defaults: {},
            schema: [{
                key: 'temperature',
                type: 'number',
                label: 'Temperature',
                mapsTo: { target: 'body', path: 'temperature' },
            }],
            uiSchema: {
                groups: [{ id: 'generation', label: 'Generation' }],
                fields: [{ key: 'temperature', widget: 'slider', visibility: 'basic' }],
            },
            limits: { known: true, maxOutputTokens: 8192 },
            sourceUrls: [],
        }
        const registry: RegistryCache = {
            schemaVersion: 4,
            registries: {
                test: {
                    fetchedAt: 0,
                    baseProviders: { demo: base },
                    profiles: { 'demo:model': profile },
                },
            },
        }

        const snapshot = resolveSnapshot(registry, profile.id)
        expect(snapshot.schema.map((field) => field.key)).toEqual(['apiKey', 'modelId', 'temperature'])
        expect(snapshot.schema.find((field) => field.key === 'modelId')?.default).toBe('model-v1')
        expect(snapshot.uiSchema.groups.map((group) => group.id)).toEqual(['base', 'generation'])
        expect(snapshot.limits).toEqual({
            known: true,
            contextWindowTokens: 65536,
            maxOutputTokens: 8192,
        })
    })

    test('throws typed errors for missing profiles and base providers', () => {
        expect(() => resolveSnapshot(loadSpecialRegistry(), 'missing'))
            .toThrow(RegistryProfileNotFoundError)

        const malformed: RegistryCache = {
            schemaVersion: 4,
            registries: {
                test: {
                    fetchedAt: 0,
                    baseProviders: {},
                    profiles: {
                        broken: { id: 'broken', providerBaseId: 'missing' } as ModelProfile,
                    },
                },
            },
        }
        expect(() => resolveSnapshot(malformed, 'broken'))
            .toThrow(RegistryBaseProviderNotFoundError)
    })
})

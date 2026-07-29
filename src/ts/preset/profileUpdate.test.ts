import { describe, expect, test } from 'vitest'
import {
    applyProfileSnapshotUpdate,
    createModelPresetFromProfile,
    diffProfileSnapshot,
    isUsableModelProfileSnapshot,
    refreshModelPresetProfile,
    replaceModelPresetProfile,
} from './profileUpdate'
import { resolveSnapshot } from './registry/snapshot'
import { compileModelPreset } from './runtime/compilePreset'
import type {
    BaseProviderDefinition,
    ModelPreset,
    ModelProfile,
    RegistryCache,
    RegistryFieldSchema,
    RegistryUiSchema,
    ResolvedModelProfileSnapshot,
} from './types'

function makeRegistry(profiles: ModelProfile[], baseProviders: BaseProviderDefinition[]): RegistryCache {
    const baseMap: Record<string, BaseProviderDefinition> = {}
    for (const b of baseProviders) baseMap[b.id] = b
    const profileMap: Record<string, ModelProfile> = {}
    for (const p of profiles) profileMap[p.id] = p
    return {
        schemaVersion: 4,
        registries: {
            synthetic: {
                fetchedAt: 0,
                baseProviders: baseMap,
                profiles: profileMap,
            },
        },
    }
}

function makeBaseProvider(overrides: Partial<BaseProviderDefinition> = {}): BaseProviderDefinition {
    return {
        id: 'demo',
        displayName: 'Demo',
        adapterKind: 'openai-compatible',
        authKinds: ['bearer'],
        endpointKinds: ['static'],
        defaultHeaders: { 'Content-Type': 'application/json' },
        requestSchema: [
            {
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: {
            groups: [{ id: 'credentials', label: 'Credentials', order: 1 }],
            fields: [
                { key: 'apiKey', widget: 'secret', visibility: 'basic', group: 'credentials' },
                { key: 'modelId', widget: 'text', visibility: 'basic', group: 'credentials' },
            ],
        },
        capabilities: ['streaming'],
        sourceUrls: ['https://example.test'],
        ...overrides,
    }
}

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
    return {
        id: 'demo:standard',
        displayName: 'Demo Standard',
        providerBaseId: 'demo',
        profileStatus: 'current',
        modelId: 'demo-fast',
        endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
        auth: { kind: 'bearer', fields: ['apiKey'] },
        defaults: {},
        schema: [],
        uiSchema: { groups: [], fields: [] },
        sourceUrls: ['https://example.test/profile'],
        ...overrides,
    }
}

function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:standard',
        providerBaseId: 'demo',
        adapterKind: 'openai-compatible',
        auth: { kind: 'bearer', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
        modelId: 'demo-fast',
        schema: [
            {
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: {
            groups: [{ id: 'credentials', label: 'Credentials', order: 1 }],
            fields: [
                { key: 'apiKey', widget: 'secret', visibility: 'basic', group: 'credentials' },
                { key: 'modelId', widget: 'text', visibility: 'basic', group: 'credentials' },
            ],
        },
        defaults: {},
        headerTemplate: { 'Content-Type': 'application/json' },
        capabilities: ['streaming'],
        ...overrides,
    }
}

function makePreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset-1',
        name: 'My Preset',
        profileSnapshot: makeSnapshot(),
        userValues: { apiKey: 'sk-test', modelId: 'demo-fast' },
        sourceProfile: {
            registryId: 'synthetic',
            profileId: 'demo:standard',
            fetchedAt: 100,
        },
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    }
}

describe('ModelPreset profile lifecycle', () => {
    test('creates a self-contained preset with seeded defaults and one timestamp', () => {
        const profile = makeProfile({
            updatedAt: 500,
            schema: [{
                key: 'verbosity',
                type: 'string',
                label: 'Verbosity',
                default: 'medium',
            }],
            uiSchema: {
                groups: [],
                fields: [{ key: 'verbosity', widget: 'select', visibility: 'basic' }],
            },
        })
        const registry = makeRegistry([profile], [makeBaseProvider()])

        const preset = createModelPresetFromProfile({
            registry,
            registryId: 'synthetic',
            profileId: profile.id,
        }, {
            id: 'new-preset',
            apiKeyRef: 'key-1',
            abilityDefaults: {
                foldSystemPrompt: true,
                alternateRole: true,
            },
            now: () => 900,
        })

        expect(preset).toMatchObject({
            id: 'new-preset',
            name: 'Demo Standard',
            apiKeyRef: 'key-1',
            userValues: { verbosity: 'medium' },
            sourceProfile: {
                registryId: 'synthetic',
                profileId: 'demo:standard',
                fetchedAt: 900,
                profileUpdatedAt: 500,
            },
            foldSystemPrompt: true,
            alternateRole: true,
            createdAt: 900,
            updatedAt: 900,
        })
        expect(preset?.profileSnapshot.modelId).toBe('demo-fast')
    })

    test('keeps transient plugin-style creations snapshot-only', () => {
        const registry = makeRegistry([makeProfile()], [makeBaseProvider()])

        const preset = createModelPresetFromProfile({
            registry,
            registryId: 'synthetic',
            profileId: 'demo:standard',
            transient: true,
        }, {
            id: 'plugin-preset',
            abilityDefaults: { startWithUserInput: true },
            now: () => 700,
        })

        expect(preset?.sourceProfile).toBeUndefined()
        expect(preset?.startWithUserInput).toBe(true)
    })

    test('replaces a profile through the shared value migration path', () => {
        const profile = makeProfile({
            id: 'demo:replacement',
            displayName: 'Replacement',
            modelId: 'demo-v2',
            updatedAt: 600,
            schema: [{
                key: 'verbosity',
                type: 'string',
                label: 'Verbosity',
                default: 'high',
            }],
            uiSchema: {
                groups: [],
                fields: [{ key: 'verbosity', widget: 'select', visibility: 'basic' }],
            },
        })
        const registry = makeRegistry([profile], [makeBaseProvider()])
        const original = makePreset({
            userValues: {
                apiKey: 'sk-test',
                modelId: 'custom-model',
                removed: 'drop-me',
            },
        })

        const result = replaceModelPresetProfile(original, {
            registry,
            registryId: 'synthetic',
            profileId: profile.id,
        }, {
            now: () => 950,
        })

        expect(result?.droppedKeys).toEqual(['removed'])
        expect(result?.preset.userValues).toEqual({
            apiKey: 'sk-test',
            modelId: 'custom-model',
            verbosity: 'high',
        })
        expect(result?.preset.orphanValues).toEqual({ removed: 'drop-me' })
        expect(result?.preset.sourceProfile).toEqual({
            registryId: 'synthetic',
            profileId: 'demo:replacement',
            fetchedAt: 950,
            profileUpdatedAt: 600,
        })
        expect(result?.preset.profileSnapshot.modelId).toBe('demo-v2')
        expect(result?.preset.updatedAt).toBe(950)
        expect(original.profileSnapshot.profileId).toBe('demo:standard')
        expect(original.userValues).toHaveProperty('removed')
    })

    test('moves same-key type changes to orphanValues during replacement', () => {
        const profile = makeProfile({
            id: 'demo:typed-replacement',
            displayName: 'Typed Replacement',
            schema: [{
                key: 'verbosity',
                type: 'integer',
                label: 'Verbosity',
                default: 1,
            }],
            uiSchema: {
                groups: [],
                fields: [{ key: 'verbosity', widget: 'number-input', visibility: 'basic' }],
            },
        })
        const registry = makeRegistry([profile], [makeBaseProvider()])
        const currentSnapshot = makeSnapshot({
            schema: [
                ...makeSnapshot().schema,
                { key: 'verbosity', type: 'string', label: 'Verbosity' },
            ],
            uiSchema: {
                groups: [],
                fields: [
                    ...makeSnapshot().uiSchema.fields,
                    { key: 'verbosity', widget: 'text', visibility: 'basic' },
                ],
            },
        })
        const original = makePreset({
            profileSnapshot: currentSnapshot,
            userValues: {
                apiKey: 'sk-test',
                modelId: 'custom-model',
                verbosity: 'high',
            },
            orphanValues: { older: 'kept' },
        })

        const result = replaceModelPresetProfile(original, {
            registry,
            registryId: 'synthetic',
            profileId: profile.id,
        })

        expect(result?.droppedKeys).toEqual(['verbosity'])
        expect(result?.preset.userValues).toEqual({
            apiKey: 'sk-test',
            modelId: 'custom-model',
            verbosity: 1,
        })
        expect(result?.preset.orphanValues).toEqual({
            older: 'kept',
            verbosity: 'high',
        })
        expect(original.userValues.verbosity).toBe('high')
        expect(original.orphanValues).toEqual({ older: 'kept' })
    })

    test('accepts executable fixed profiles with an empty settings form', () => {
        const profile = makeProfile({
            id: 'plugin:fixed',
            displayName: 'Fixed Plugin',
            providerBaseId: 'fixed-plugin',
            modelId: 'pluginmodel:::fixed',
            auth: { kind: 'none', fields: [] },
            endpoint: { kind: 'static', url: 'plugin://fixed' },
            schema: [],
            uiSchema: { groups: [], fields: [] },
        })
        const registry = makeRegistry([profile], [makeBaseProvider({
            id: 'fixed-plugin',
            adapterKind: 'plugin',
            authKinds: ['none'],
            requestSchema: [],
            uiSchema: { groups: [], fields: [] },
        })])

        const snapshot = resolveSnapshot(registry, profile.id)
        expect(isUsableModelProfileSnapshot(snapshot)).toBe(true)
        const preset = createModelPresetFromProfile({
            registry,
            registryId: 'synthetic',
            profileId: profile.id,
            transient: true,
        }, {
            id: 'fixed-preset',
        })
        expect(preset).toMatchObject({
            id: 'fixed-preset',
            sourceProfile: undefined,
            userValues: {},
            profileSnapshot: {
                adapterKind: 'plugin',
                schema: [],
                uiSchema: { groups: [], fields: [] },
            },
        })
        expect(compileModelPreset(preset!).backend).toBe('plugin')
    })

    test('refuses snapshots missing runtime connection metadata', () => {
        const registry = makeRegistry(
            [makeProfile({ endpoint: null as any })],
            [makeBaseProvider({ requestSchema: [], uiSchema: { groups: [], fields: [] } })],
        )

        const snapshot = resolveSnapshot(registry, 'demo:standard')
        expect(isUsableModelProfileSnapshot(snapshot)).toBe(false)
        expect(createModelPresetFromProfile({
            registry,
            registryId: 'synthetic',
            profileId: 'demo:standard',
        }, {
            id: 'invalid',
        })).toBeUndefined()
        expect(replaceModelPresetProfile(makePreset(), {
            registry,
            registryId: 'synthetic',
            profileId: 'demo:standard',
        })).toBeUndefined()
    })
})

describe('refreshModelPresetProfile', () => {
    test('force-refreshes schema UI without revision metadata', () => {
        const preset = makePreset()
        const profile = makeProfile({
            updatedAt: 500,
            schema: [{
                key: 'verbosity',
                type: 'string',
                label: 'Verbosity',
                default: 'medium',
            }],
            uiSchema: {
                groups: [{ id: 'connection', label: 'Connection' }],
                fields: [{
                    key: 'verbosity',
                    widget: 'select',
                    visibility: 'basic',
                    layout: 'row',
                    group: 'connection',
                }],
            },
        })
        const registry = makeRegistry([profile], [makeBaseProvider()])

        const result = refreshModelPresetProfile(preset, {
            registry,
            registryId: 'synthetic',
            profileId: 'demo:standard',
        }, { now: () => 900 })

        expect(result?.preset.profileSnapshot.uiSchema.fields).toContainEqual(
            expect.objectContaining({
                key: 'verbosity',
                visibility: 'basic',
                layout: 'row',
            }),
        )
        expect(result?.preset.userValues).toEqual({
            apiKey: 'sk-test',
            modelId: 'demo-fast',
            verbosity: 'medium',
        })
        expect(result?.preset.sourceProfile).toEqual({
            registryId: 'synthetic',
            profileId: 'demo:standard',
            fetchedAt: 900,
            profileUpdatedAt: 500,
        })
        expect(result?.preset.updatedAt).toBe(900)
    })

    test('keeps transient plugin presets self-contained', () => {
        const preset = makePreset({ sourceProfile: undefined })
        const registry = makeRegistry([makeProfile()], [makeBaseProvider()])

        const result = refreshModelPresetProfile(preset, {
            registry,
            registryId: 'synthetic',
            profileId: 'demo:standard',
            transient: true,
        })

        expect(result?.preset.sourceProfile).toBeUndefined()
    })

    test('backfills source metadata for a legacy self-contained preset', () => {
        const preset = makePreset({ sourceProfile: undefined })
        const registry = makeRegistry([makeProfile({ updatedAt: 700 })], [makeBaseProvider()])

        const result = refreshModelPresetProfile(preset, {
            registry,
            registryId: 'synthetic',
            profileId: 'demo:standard',
        }, { now: () => 800 })

        expect(result?.preset.sourceProfile).toEqual({
            registryId: 'synthetic',
            profileId: 'demo:standard',
            fetchedAt: 800,
            profileUpdatedAt: 700,
        })
    })

    test('returns undefined when the exact source registry has no matching profile', () => {
        const preset = makePreset()
        const registry = makeRegistry([makeProfile()], [makeBaseProvider()])

        expect(refreshModelPresetProfile(preset, {
            registry,
            registryId: 'missing',
            profileId: 'demo:standard',
        })).toBeUndefined()
    })
})

describe('diffProfileSnapshot', () => {
    test('returns no changes for identical snapshots', () => {
        const snapshot = makeSnapshot()
        const diff = diffProfileSnapshot(snapshot, makeSnapshot())
        expect(diff.schemaChanges).toEqual([])
        expect(diff.uiSchemaFieldChanges).toEqual([])
        expect(diff.uiSchemaGroupChanges).toEqual([])
        expect(diff.endpointChanged).toBe(false)
        expect(diff.authChanged).toBe(false)
        expect(diff.modelIdChanged).toBe(false)
        expect(diff.capabilitiesChanged).toBe(false)
        expect(diff.defaultsChanged).toBe(false)
        expect(diff.bodyTemplateChanged).toBe(false)
        expect(diff.headerTemplateChanged).toBe(false)
        expect(diff.providerBaseChanged).toBe(false)
        expect(diff.adapterKindChanged).toBe(false)
    })

    test('detects added, removed, and modified schema fields', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            schema: [
                {
                    key: 'apiKey',
                    type: 'string',
                    label: 'API Key (renamed)',
                    secret: true,
                    mapsTo: { target: 'auth', path: 'apiKey' },
                },
                {
                    key: 'reasoning',
                    type: 'string',
                    label: 'Reasoning Effort',
                    mapsTo: { target: 'body', path: 'reasoning_effort' },
                },
            ],
        })
        const diff = diffProfileSnapshot(current, latest)
        const byKey = Object.fromEntries(diff.schemaChanges.map((c) => [c.key, c]))
        expect(byKey.apiKey?.changeKind).toBe('modified')
        expect(byKey.apiKey?.modifiedAttributes).toEqual(['label'])
        expect(byKey.modelId?.changeKind).toBe('removed')
        expect(byKey.reasoning?.changeKind).toBe('added')
    })

    test('marks schema field type change with fromType/toType', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            schema: [
                { key: 'apiKey', type: 'string', label: 'API Key', secret: true },
                { key: 'modelId', type: 'integer', label: 'Model ID' },
            ],
        })
        const diff = diffProfileSnapshot(current, latest)
        const modelChange = diff.schemaChanges.find((c) => c.key === 'modelId')
        expect(modelChange?.changeKind).toBe('modified')
        expect(modelChange?.fromType).toBe('string')
        expect(modelChange?.toType).toBe('integer')
        expect(modelChange?.modifiedAttributes).toContain('type')
    })

    test('detects canonical semantic metadata changes', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            schema: current.schema.map((field) =>
                field.key === 'modelId'
                    ? { ...field, semantic: 'modelId' }
                    : field,
            ),
        })

        const diff = diffProfileSnapshot(current, latest)

        expect(diff.schemaChanges.find((change) => change.key === 'modelId'))
            .toMatchObject({
                changeKind: 'modified',
                modifiedAttributes: ['semantic'],
            })
    })

    test('detects endpoint url change', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            endpoint: { kind: 'static', url: 'https://demo.test/v2/chat/completions' },
        })
        const diff = diffProfileSnapshot(current, latest)
        expect(diff.endpointChanged).toBe(true)
    })

    test('detects auth kind change', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({ auth: { kind: 'x-api-key', fields: ['apiKey'] } })
        const diff = diffProfileSnapshot(current, latest)
        expect(diff.authChanged).toBe(true)
    })

    test('detects modelId, capabilities, defaults, and template changes', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            modelId: 'demo-faster',
            capabilities: ['streaming', 'vision'],
            defaults: { temperature: 0.7 },
            bodyTemplate: { stream: true },
            headerTemplate: { 'Content-Type': 'application/json', 'X-Extra': '1' },
        })
        const diff = diffProfileSnapshot(current, latest)
        expect(diff.modelIdChanged).toBe(true)
        expect(diff.capabilitiesChanged).toBe(true)
        expect(diff.defaultsChanged).toBe(true)
        expect(diff.bodyTemplateChanged).toBe(true)
        expect(diff.headerTemplateChanged).toBe(true)
    })

    test('detects ui group and field changes', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            uiSchema: {
                groups: [
                    { id: 'credentials', label: 'Credentials', order: 1 },
                    { id: 'advanced', label: 'Advanced', order: 2 },
                ],
                fields: [
                    { key: 'apiKey', widget: 'secret', visibility: 'basic', group: 'credentials' },
                    { key: 'modelId', widget: 'select', visibility: 'basic', group: 'credentials' },
                ],
            },
        })
        const diff = diffProfileSnapshot(current, latest)
        expect(diff.uiSchemaGroupChanges).toEqual([{ id: 'advanced', changeKind: 'added' }])
        const modelChange = diff.uiSchemaFieldChanges.find((c) => c.key === 'modelId')
        expect(modelChange?.changeKind).toBe('modified')
        expect(modelChange?.modifiedAttributes).toEqual(['widget'])
    })
})

describe('applyProfileSnapshotUpdate', () => {
    test('keeps user values whose schema field survives unchanged', () => {
        const preset = makePreset({
            userValues: { apiKey: 'sk-test', modelId: 'demo-fast' },
        })
        const latestSnapshot = makeSnapshot()
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot, { now: () => 200 })
        expect(result.preset.userValues).toEqual({ apiKey: 'sk-test', modelId: 'demo-fast' })
        expect(result.preset.orphanValues).toBeUndefined()
        expect(result.movedToOrphan).toEqual([])
        expect(result.newFieldKeys).toEqual([])
        expect(result.preset.updatedAt).toBe(200)
    })

    test('moves user values to orphanValues when schema field is removed', () => {
        const preset = makePreset({
            userValues: { apiKey: 'sk-test', modelId: 'demo-fast', removedKey: 'gone' },
            profileSnapshot: makeSnapshot({
                schema: [
                    ...makeSnapshot().schema,
                    {
                        key: 'removedKey',
                        type: 'string',
                        label: 'Removed',
                        mapsTo: { target: 'body', path: 'removed' },
                    },
                ],
            }),
        })
        const latestSnapshot = makeSnapshot()
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot, { now: () => 300 })
        expect(result.preset.userValues).toEqual({ apiKey: 'sk-test', modelId: 'demo-fast' })
        expect(result.preset.orphanValues).toEqual({ removedKey: 'gone' })
        expect(result.movedToOrphan).toEqual([
            { key: 'removedKey', value: 'gone', reason: 'removed' },
        ])
    })

    test('moves user values to orphanValues when field type changes', () => {
        const preset = makePreset({
            userValues: { apiKey: 'sk-test', modelId: 'demo-fast' },
        })
        const latestSnapshot = makeSnapshot({
            schema: [
                makePreset().profileSnapshot.schema[0],
                {
                    key: 'modelId',
                    type: 'integer',
                    label: 'Model ID',
                    mapsTo: { target: 'body', path: 'model' },
                },
            ],
        })
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot, { now: () => 400 })
        expect(result.preset.userValues).toEqual({ apiKey: 'sk-test' })
        expect(result.preset.orphanValues).toEqual({ modelId: 'demo-fast' })
        expect(result.movedToOrphan).toEqual([
            { key: 'modelId', value: 'demo-fast', reason: 'type-changed' },
        ])
    })

    test('reports new field keys added in the latest snapshot', () => {
        const preset = makePreset()
        const latestSnapshot = makeSnapshot({
            schema: [
                ...makeSnapshot().schema,
                {
                    key: 'reasoning',
                    type: 'string',
                    label: 'Reasoning Effort',
                    mapsTo: { target: 'body', path: 'reasoning_effort' },
                },
            ],
        })
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot)
        expect(result.newFieldKeys).toEqual(['reasoning'])
        expect(result.preset.userValues).toEqual({ apiKey: 'sk-test', modelId: 'demo-fast' })
    })

    test('uses provided sourceProfile and falls back to bumping the current one', () => {
        const preset = makePreset()
        const latestSnapshot = makeSnapshot()

        const explicit = applyProfileSnapshotUpdate(preset, latestSnapshot, {
            now: () => 500,
            sourceProfile: {
                registryId: 'custom',
                profileId: 'demo:standard',
                fetchedAt: 500,
            },
        })
        expect(explicit.preset.sourceProfile).toEqual({
            registryId: 'custom',
            profileId: 'demo:standard',
            fetchedAt: 500,
        })

        const bumped = applyProfileSnapshotUpdate(preset, latestSnapshot, { now: () => 600 })
        expect(bumped.preset.sourceProfile).toEqual({
            registryId: 'synthetic',
            profileId: 'demo:standard',
            fetchedAt: 600,
        })

        const noSource = applyProfileSnapshotUpdate(
            makePreset({ sourceProfile: undefined }),
            latestSnapshot,
            { now: () => 700 },
        )
        expect(noSource.preset.sourceProfile).toBeUndefined()
    })

    test('does not keep stale sourceProfile fallback when latest snapshot is for a different profile', () => {
        const result = applyProfileSnapshotUpdate(
            makePreset(),
            makeSnapshot({ profileId: 'demo:other' }),
            { now: () => 800 },
        )
        expect(result.preset.sourceProfile).toBeUndefined()
    })

    test('uses one timestamp for sourceProfile fallback and updatedAt', () => {
        let currentTime = 900
        const result = applyProfileSnapshotUpdate(
            makePreset(),
            makeSnapshot(),
            { now: () => currentTime++ },
        )
        expect(result.preset.sourceProfile?.fetchedAt).toBe(900)
        expect(result.preset.updatedAt).toBe(900)
    })

    test('accumulates orphan values across consecutive updates', () => {
        const initialSnapshot = makeSnapshot({
            schema: [
                ...makeSnapshot().schema,
                {
                    key: 'legacyA',
                    type: 'string',
                    label: 'A',
                    mapsTo: { target: 'body', path: 'a' },
                },
                {
                    key: 'legacyB',
                    type: 'string',
                    label: 'B',
                    mapsTo: { target: 'body', path: 'b' },
                },
            ],
        })
        const preset = makePreset({
            profileSnapshot: initialSnapshot,
            userValues: { apiKey: 'sk', modelId: 'm', legacyA: 'a-value', legacyB: 'b-value' },
        })

        const afterFirst = applyProfileSnapshotUpdate(
            preset,
            makeSnapshot({
                schema: [
                    ...makeSnapshot().schema,
                    {
                        key: 'legacyB',
                        type: 'string',
                        label: 'B',
                        mapsTo: { target: 'body', path: 'b' },
                    },
                ],
            }),
            { now: () => 800 },
        ).preset
        expect(afterFirst.orphanValues).toEqual({ legacyA: 'a-value' })

        const afterSecond = applyProfileSnapshotUpdate(
            afterFirst,
            makeSnapshot(),
            { now: () => 900 },
        ).preset
        expect(afterSecond.orphanValues).toEqual({ legacyA: 'a-value', legacyB: 'b-value' })
    })

    test('resolved registry snapshot feeds applyProfileSnapshotUpdate end-to-end', () => {
        const preset = makePreset()
        const registry = makeRegistry(
            [
                makeProfile({
                    schema: [
                        {
                            key: 'reasoning',
                            type: 'string',
                            label: 'Reasoning Effort',
                            enum: [
                                { value: 'low', label: 'Low' },
                                { value: 'high', label: 'High' },
                            ],
                            mapsTo: { target: 'body', path: 'reasoning_effort' },
                        },
                    ],
                    uiSchema: {
                        groups: [],
                        fields: [
                            { key: 'reasoning', widget: 'select', visibility: 'advanced' },
                        ],
                    },
                }),
            ],
            [makeBaseProvider()],
        )
        const latestSnapshot = resolveSnapshot(registry, 'demo:standard')
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot, {
            now: () => 1000,
            sourceProfile: {
                registryId: 'synthetic',
                profileId: 'demo:standard',
                fetchedAt: 1000,
            },
        })
        expect(result.preset.sourceProfile?.fetchedAt).toBe(1000)
        expect(result.newFieldKeys).toContain('reasoning')
        expect(result.preset.profileSnapshot.schema.map((f) => f.key)).toEqual([
            'apiKey',
            'modelId',
            'reasoning',
        ])
    })
})

// Tiny smoke that imports the shared types compile cleanly; keeps unused-import lint quiet
// when refactoring the test helpers.
function _typeGuards(_field: RegistryFieldSchema, _ui: RegistryUiSchema): void {}
void _typeGuards

/**
 * Integration coverage for `applyProfileSnapshotUpdate` (plan §14-7 / §14-11).
 *
 * Unit-level tests already cover `diffProfileSnapshot` (see
 * profileUpdate.test.ts). This file exercises the apply step end-to-end:
 * starting from a ModelPreset that targets an older profile snapshot, resolve
 * the current registry snapshot, apply it, and assert that the resulting
 * ModelPreset is internally coherent.
 */
import { describe, expect, test } from 'vitest'
import { applyProfileSnapshotUpdate } from './profileUpdate'
import { resolveSnapshot } from './registry/snapshot'
import type {
    BaseProviderDefinition,
    ModelPreset,
    ModelProfile,
    RegistryCache,
    ResolvedModelProfileSnapshot,
} from './types'

function makeBaseProvider(): BaseProviderDefinition {
    return {
        id: 'demo',
        displayName: 'Demo',
        adapterKind: 'openai-compatible',
        authKinds: ['bearer'],
        endpointKinds: ['static'],
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
        uiSchema: { groups: [], fields: [] },
        sourceUrls: ['https://example.test/docs'],
    }
}

function makeProfileV1(): ModelProfile {
    return {
        id: 'demo:standard',
        displayName: 'Demo v1',
        providerBaseId: 'demo',
        profileStatus: 'current',
        modelId: 'demo-v1',
        endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
        auth: { kind: 'bearer', fields: ['apiKey'] },
        defaults: { temperature: 0.5 },
        schema: [
            {
                key: 'reasoningEffort',
                type: 'string',
                label: 'Reasoning Effort',
                default: 'low',
                mapsTo: { target: 'body', path: 'reasoning_effort' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        capabilities: ['streaming'],
        sourceUrls: ['https://example.test/docs'],
    }
}

function makeProfileV2(): ModelProfile {
    // v2 introduces a new field, removes the v1-only `reasoningEffort` field,
    // and bumps the model id. This is the exact shape the snapshot-update
    // path must handle: orphan → orphanValues, new field becomes addressable.
    return {
        id: 'demo:standard',
        displayName: 'Demo v2',
        providerBaseId: 'demo',
        profileStatus: 'current',
        modelId: 'demo-v2',
        endpoint: { kind: 'static', url: 'https://demo.test/v2/chat/completions' },
        auth: { kind: 'bearer', fields: ['apiKey'] },
        defaults: { temperature: 0.7 },
        schema: [
            {
                key: 'thinkingBudget',
                type: 'integer',
                label: 'Thinking Budget',
                default: 1024,
                mapsTo: { target: 'body', path: 'thinking.budget_tokens' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        capabilities: ['streaming', 'reasoning'],
        sourceUrls: ['https://example.test/docs'],
    }
}

function makeRegistry(profile: ModelProfile): RegistryCache {
    return {
        schemaVersion: 4,
        registries: {
            bundled: {
                fetchedAt: 1_000,
                baseProviders: { demo: makeBaseProvider() },
                profiles: { [profile.id]: profile },
            },
        },
    }
}

function snapshotFor(profile: ModelProfile): ResolvedModelProfileSnapshot {
    return resolveSnapshot(makeRegistry(profile), profile.id)
}

function makePresetOnV1(): ModelPreset {
    const v1Snapshot = snapshotFor(makeProfileV1())
    return {
        id: 'preset-1',
        name: 'My Demo Preset',
        sourceProfile: {
            registryId: 'bundled',
            profileId: 'demo:standard',
            fetchedAt: 1_000,
        },
        profileSnapshot: v1Snapshot,
        userValues: {
            modelId: 'demo-v1-custom',
            reasoningEffort: 'high', // will become orphan on v2
        },
        createdAt: 100,
        updatedAt: 100,
    }
}

describe('applyProfileSnapshotUpdate — end-to-end v1 → v2 migration', () => {
    test('upgrades preset to v2 snapshot, moves removed field to orphanValues, exposes new field as added', () => {
        const preset = makePresetOnV1()
        const v2Registry = makeRegistry(makeProfileV2())

        const latestSnapshot = resolveSnapshot(v2Registry, 'demo:standard')
        const result = applyProfileSnapshotUpdate(
            preset,
            latestSnapshot,
            {
                now: () => 2_000,
                sourceProfile: {
                    registryId: 'bundled',
                    profileId: 'demo:standard',
                    fetchedAt: 2_000,
                },
            },
        )

        // Resulting preset points at the current snapshot.
        expect(result.preset.profileSnapshot.modelId).toBe('demo-v2')
        expect(result.preset.sourceProfile?.fetchedAt).toBe(2_000)
        expect(result.preset.updatedAt).toBe(2_000)

        // userValues only retain keys still present in v2 schema.
        expect(result.preset.userValues).toEqual({ modelId: 'demo-v1-custom' })

        // Removed field flows into orphanValues for later manual recovery.
        expect(result.preset.orphanValues).toEqual({ reasoningEffort: 'high' })
        expect(result.movedToOrphan).toEqual([
            { key: 'reasoningEffort', value: 'high', reason: 'removed' },
        ])

        // New field surfaces in newFieldKeys for UI to highlight.
        expect(result.newFieldKeys).toEqual(['thinkingBudget'])

        // Diff snapshot is internally consistent.
        expect(result.diff.modelIdChanged).toBe(true)
        expect(result.diff.endpointChanged).toBe(true)
        expect(result.diff.defaultsChanged).toBe(true)
        expect(result.diff.capabilitiesChanged).toBe(true)
    })

    test('preserves previously-stored orphanValues across an update', () => {
        const preset = makePresetOnV1()
        preset.orphanValues = { staleKey: 'from-an-older-cycle' }

        const latestSnapshot = snapshotFor(makeProfileV2())
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot, {
            now: () => 2_000,
            sourceProfile: { registryId: 'bundled', profileId: 'demo:standard', fetchedAt: 2_000 },
        })

        // Both old and newly-orphaned keys survive.
        expect(result.preset.orphanValues).toEqual({
            staleKey: 'from-an-older-cycle',
            reasoningEffort: 'high',
        })
    })

    test('type-changed field also moves to orphanValues (regression for §14-7 rule)', () => {
        const preset = makePresetOnV1()
        // userValues now has a value for a key that v2 keeps but with a
        // different type — simulate by re-using `reasoningEffort` in v2 but
        // typed as integer instead of string.
        const v2 = makeProfileV2()
        v2.schema = [
            ...v2.schema,
            {
                key: 'reasoningEffort',
                type: 'integer', // was 'string' in v1
                label: 'Reasoning Effort (numeric)',
                mapsTo: { target: 'body', path: 'reasoning_effort' },
            },
        ]
        const latestSnapshot = snapshotFor(v2)
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot, {
            now: () => 2_000,
            sourceProfile: { registryId: 'bundled', profileId: 'demo:standard', fetchedAt: 2_000 },
        })

        expect(result.movedToOrphan).toEqual([
            { key: 'reasoningEffort', value: 'high', reason: 'type-changed' },
        ])
        expect(result.preset.orphanValues).toEqual({ reasoningEffort: 'high' })
        // userValues drops the type-incompatible value rather than coercing.
        expect(result.preset.userValues.reasoningEffort).toBeUndefined()
    })

    test('does not mutate the input preset', () => {
        const preset = makePresetOnV1()
        const snapshotBefore = JSON.stringify(preset)

        const latestSnapshot = snapshotFor(makeProfileV2())
        applyProfileSnapshotUpdate(preset, latestSnapshot, {
            now: () => 2_000,
            sourceProfile: { registryId: 'bundled', profileId: 'demo:standard', fetchedAt: 2_000 },
        })

        expect(JSON.stringify(preset)).toBe(snapshotBefore)
    })

    test('keeps userValues untouched when the snapshot is functionally identical', () => {
        const preset = makePresetOnV1()
        // Pretend the registry already has v1 — availability returns 'current'
        // and there's nothing to apply. But if a caller forces an apply with
        // the same snapshot, the result must not throw away userValues.
        const sameSnapshot = preset.profileSnapshot
        const result = applyProfileSnapshotUpdate(preset, sameSnapshot, {
            now: () => 2_000,
            sourceProfile: preset.sourceProfile,
        })

        expect(result.preset.userValues).toEqual(preset.userValues)
        expect(result.preset.orphanValues).toBeUndefined()
        expect(result.movedToOrphan).toEqual([])
        expect(result.newFieldKeys).toEqual([])
    })

    test('drops sourceProfile when the latest snapshot belongs to a different profile id', () => {
        const preset = makePresetOnV1()
        // Force a snapshot from a completely different profile id.
        const otherProfile: ModelProfile = { ...makeProfileV2(), id: 'demo:other' }
        const otherSnapshot = snapshotFor(otherProfile)
        const result = applyProfileSnapshotUpdate(preset, otherSnapshot, {
            now: () => 2_000,
            // no sourceProfile override; the helper should clear it because
            // preset.sourceProfile.profileId !== latestSnapshot.profileId
        })

        expect(result.preset.sourceProfile).toBeUndefined()
        expect(result.preset.profileSnapshot.profileId).toBe('demo:other')
    })
})

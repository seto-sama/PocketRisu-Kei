import type { ApiKeyPoolEntry, ModelPreset, ModelPresetMigrationSummary, RegistryCache, ResolvedModelProfileSnapshot } from './types'
import { resolveSnapshot } from './registry/snapshot'
import { loadSpecialRegistry } from './registry/loader'
import {
    applyProfileSnapshotUpdate,
    isUsableModelProfileSnapshot,
} from './profileUpdate'

export interface ModelPresetDefaultsTarget {
    modelPresets?: ModelPreset[]
    modelPresetMigrationVersion?: number
    modelPresetMigrationAppliedAt?: number
    modelPresetMigrationReport?: ModelPresetMigrationSummary
    apiKeyPool?: Record<string, ApiKeyPoolEntry>
    modelProfileRegistryCache?: RegistryCache
    modelProfileRegistryLastFetched?: number
    // `currentOnly` is accepted here only to migrate databases written before
    // the models.dev catalog reduced this setting to two levels.
    modelProfileVisibilityLevel?: 'all' | 'hideDeprecated' | 'currentOnly'
    modelProfileHiddenProviderIds?: string[]
    modelProfileProviderFilterInitialized?: boolean
    modelPresetDefaultMaxContext?: number
    modelPresetDefaultMaxResponse?: number
    modelPresetPromptPresetFirst?: boolean
    modelPresetPromptParamsFirst?: boolean
}

export function createEmptyRegistryCache(): RegistryCache {
    return {
        schemaVersion: 4,
        registries: {},
    }
}

// A persisted profileSnapshot can carry null/undefined elements in its schema /
// uiSchema arrays, or — for a degenerate snapshot — a missing / non-array schema
// or uiSchema altogether (legacy/malformed registry data). The resolve path
// filters these, but already-saved presets keep them and crash every consumer
// that reads `.key`/`.map()`/`.fields` — the settings UI on render, buildRequest /
// wireInvariants on send, and other consumers of the frozen snapshot. Normalize
// once at the load boundary so all paths see a
// snapshot whose schema / uiSchema.groups / uiSchema.fields are always (possibly
// empty) arrays; the cleaned value persists with the next save.
function sanitizeModelPresetSnapshots(presets: ModelPreset[]): Set<ModelPreset> {
    const structurallyIncomplete = new Set<ModelPreset>()
    for (const preset of presets) {
        const snapshot = preset?.profileSnapshot as any
        // Revision ordering is timestamp-based. Remove retired counters from
        // older persisted presets so they disappear on the next save.
        if (preset.sourceProfile) {
            delete (preset.sourceProfile as any).profileVersion
            delete (preset.sourceProfile as any).providerBaseVersion
        }
        if (!snapshot) {
            if (preset) structurallyIncomplete.add(preset)
            continue
        }
        delete snapshot.profileVersion
        delete snapshot.providerBaseVersion
        // schema → array; only reallocate when it isn't already a null-free array
        // so clean snapshots (the normal case) are left untouched on every load.
        if (!Array.isArray(snapshot.schema)) {
            structurallyIncomplete.add(preset)
            snapshot.schema = []
        } else if (!snapshot.schema.every(Boolean)) {
            structurallyIncomplete.add(preset)
            snapshot.schema = snapshot.schema.filter(Boolean)
        }
        // uiSchema → object with array groups/fields.
        if (!snapshot.uiSchema || typeof snapshot.uiSchema !== 'object') {
            structurallyIncomplete.add(preset)
            snapshot.uiSchema = { groups: [], fields: [] }
        }
        const uiSchema = snapshot.uiSchema
        if (!Array.isArray(uiSchema.groups)) {
            structurallyIncomplete.add(preset)
            uiSchema.groups = []
        } else if (!uiSchema.groups.every(Boolean)) {
            structurallyIncomplete.add(preset)
            uiSchema.groups = uiSchema.groups.filter(Boolean)
        }
        if (!Array.isArray(uiSchema.fields)) {
            structurallyIncomplete.add(preset)
            uiSchema.fields = []
        } else if (!uiSchema.fields.every(Boolean)) {
            structurallyIncomplete.add(preset)
            uiSchema.fields = uiSchema.fields.filter(Boolean)
        }
    }
    return structurallyIncomplete
}

// A snapshot is degenerate when it lost data a settings form / request needs:
// null auth/endpoint, a one-sided schema/UI form, or missing credential mapping.
// Both schema and UI may intentionally be empty for a fixed model with no
// configurable fields.
//
// A second, subtler shape: the profile's own fields resolve fine (non-empty
// schema / uiSchema.fields), but the base-provided credential field was dropped —
// auth.fields still declares e.g. ['apiKey'] yet NO schema field maps to auth
// (mapsTo.target === 'auth'), so the user has no way to enter the API key. The
// openai presets hit this (13 profile fields present, apiKey missing). Flag these
// too so heal re-resolves the credential field from the current registry.
function isDegenerateSnapshot(s: ResolvedModelProfileSnapshot | undefined): boolean {
    if (!s || !isUsableModelProfileSnapshot(s)) return true
    // An intentionally fixed profile may have no configurable fields at all.
    // A one-sided form, however, cannot render or map all of its schema.
    if ((s.schema.length === 0) !== (s.uiSchema.fields.length === 0)) return true
    const authFields = s.auth.fields
    if (Array.isArray(authFields) && authFields.length > 0) {
        const hasAuthField = s.schema.some((f) => f?.mapsTo?.target === 'auth')
        if (!hasAuthField) return true
    }
    return false
}

// Re-take a frozen-degenerate snapshot from the current registry. When we still
// know which profile a broken preset came from (sourceProfile), resolve a fresh
// snapshot from the best registry available and migrate userValues onto it via
// the normal profile-update path (type-changed values move to orphans). Applied
// only when the fresh snapshot is actually complete, so heal never makes a preset
// worse — a degenerate-but-unhealable preset falls through to the SchemaFormRenderer
// schema fallback instead. Runs at the load boundary so the repair persists with
// the next save (mirrors sanitizeModelPresetSnapshots).
function healDegenerateSnapshots(
    data: ModelPresetDefaultsTarget,
    structurallyIncomplete: ReadonlySet<ModelPreset>,
): void {
    const presets = data.modelPresets
    if (!Array.isArray(presets)) return
    // Candidate registries available synchronously at DB load: imported custom
    // profiles and the built-in Echo recipe. models.dev hydrates asynchronously,
    // so healthy saved snapshots remain self-contained and do not depend on it.
    const registries: RegistryCache[] = []
    if (data.modelProfileRegistryCache
        && Object.keys(data.modelProfileRegistryCache.registries ?? {}).length > 0) {
        registries.push(data.modelProfileRegistryCache)
    }
    registries.push(loadSpecialRegistry())

    for (let i = 0; i < presets.length; i++) {
        const preset = presets[i]
        if (
            !preset
            || (
                !structurallyIncomplete.has(preset)
                && !isDegenerateSnapshot(preset.profileSnapshot)
            )
        ) continue
        const profileId = preset.sourceProfile?.profileId
        if (!profileId) continue
        const sourceProfile = preset.sourceProfile
        for (const registry of registries) {
            // Isolate the whole attempt: malformed registry data must never abort
            // app load. The shared snapshot lifecycle owns user-value migration,
            // including removed/type-changed values and existing orphan retention.
            try {
                const fresh = resolveSnapshot(registry, profileId)
                if (isDegenerateSnapshot(fresh)) continue
                const profileUpdatedAt = Object.values(registry.registries)
                    .map((entry) => entry.profiles?.[profileId]?.updatedAt)
                    .find((value) => value !== undefined)
                    ?? sourceProfile.profileUpdatedAt
                const updatedAt = Date.now()
                presets[i] = applyProfileSnapshotUpdate(preset, fresh, {
                    now: () => updatedAt,
                    sourceProfile: {
                        ...sourceProfile,
                        profileId: fresh.profileId,
                        fetchedAt: updatedAt,
                        profileUpdatedAt,
                    },
                }).preset
                break
            } catch {
                continue
            }
        }
    }
}

export function applyModelPresetDefaults(data: ModelPresetDefaultsTarget): void {
    if (!Array.isArray(data.modelPresets)) {
        data.modelPresets = []
    }
    const structurallyIncompleteSnapshots = sanitizeModelPresetSnapshots(data.modelPresets)
    if (!data.apiKeyPool || typeof data.apiKeyPool !== 'object' || Array.isArray(data.apiKeyPool)) {
        data.apiKeyPool = {}
    }
    const customEntry = data.modelProfileRegistryCache?.schemaVersion === 4
        ? data.modelProfileRegistryCache.registries?.custom
        : undefined
    for (const profile of Object.values(customEntry?.profiles ?? {})) {
        delete (profile as any).version
    }
    for (const baseProvider of Object.values(customEntry?.baseProviders ?? {})) {
        delete (baseProvider as any).version
    }
    // The official models.dev catalog is intentionally stored in a dedicated KV
    // cache. Keep only user-imported custom profiles in the main application DB.
    data.modelProfileRegistryCache = {
        schemaVersion: 4,
        registries: customEntry ? { custom: customEntry } : {},
    }
    data.modelProfileRegistryLastFetched ??= 0
    // Default to hiding retired models. `currentOnly` was the former default;
    // models.dev does not produce PocketRisu's `outdated` status, so migrate it
    // to the equivalent two-level choice.
    if (
        data.modelProfileVisibilityLevel !== 'all'
        && data.modelProfileVisibilityLevel !== 'hideDeprecated'
    ) {
        data.modelProfileVisibilityLevel = 'hideDeprecated'
    }
    const storedProviderFilter = data.modelProfileHiddenProviderIds
    const hadStoredProviderFilter = Array.isArray(storedProviderFilter)
    data.modelProfileHiddenProviderIds = hadStoredProviderFilter
        ? [...new Set(storedProviderFilter.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
        ))]
        : []
    if (typeof data.modelProfileProviderFilterInitialized !== 'boolean') {
        // Databases that already persisted the old hidden-ID list keep their
        // exact choice. A genuinely new database receives the curated default
        // allowlist once the remote provider catalog is available.
        data.modelProfileProviderFilterInitialized = hadStoredProviderFilter
    }
    data.modelPresetDefaultMaxContext ??= 65000
    data.modelPresetDefaultMaxResponse ??= 4096
    data.modelPresetPromptPresetFirst ??= false
    data.modelPresetPromptParamsFirst ??= false
    // After the registry cache is normalized above, repair any preset whose
    // snapshot froze degenerate (empty fields) against the now-current registry.
    healDegenerateSnapshots(data, structurallyIncompleteSnapshots)
}

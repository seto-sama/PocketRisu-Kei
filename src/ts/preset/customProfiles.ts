import type {
    AdapterKind,
    BaseProviderDefinition,
    ModelProfile,
    RegistryCache,
    RegistryFieldSchema,
    ResolvedModelProfileSnapshot,
} from './types'

/**
 * Custom (user) model profiles (custom-profiles plan §5).
 *
 * Profiles are treated as shareable JSON config files: a user exports an
 * existing profile (official or custom), edits the JSON, and re-imports it to
 * use / share. Custom profiles live in their own registry inside the persisted
 * RegistryCache (`registries['custom']`), kept separate from the bundled
 * official registry — the browser shows them under a distinct tab rather than
 * merging.
 *
 * id policy: custom profile / baseProvider ids are namespaced with `custom::`
 * so they never collide with official ids. Identity is (registryId, id); the
 * prefix is the collision guard. `updatedAt` is the revision marker used for
 * update detection.
 */
export const CUSTOM_REGISTRY_ID = 'custom'
export const CUSTOM_ID_PREFIX = 'custom::'
export const FRAGMENT_SCHEMA_VERSION = 1

const ADAPTER_KINDS: AdapterKind[] = [
    'openai-compatible',
    'openai-responses',
    'anthropic-messages',
    'google-gemini',
    'amazon-bedrock',
    'custom',
    'plugin',
    'echo',
]

/** Self-contained import/export unit: one profile plus its base provider. */
export interface ProfileFragment {
    schemaVersion: number
    exportedAt?: number
    profile: ModelProfile
    baseProvider: BaseProviderDefinition
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ensureCustomId(id: string): string {
    return id.startsWith(CUSTOM_ID_PREFIX) ? id : `${CUSTOM_ID_PREFIX}${id}`
}

/**
 * Build a shareable fragment from a resolved profile + base provider. The
 * caller stamps a fresh `updatedAt` on the profile when exporting an edited
 * copy.
 */
export function buildProfileFragment(
    profile: ModelProfile,
    baseProvider: BaseProviderDefinition,
    now: number,
): ProfileFragment {
    const profileCopy = structuredClone(profile) as ModelProfile & { version?: unknown }
    const baseCopy = structuredClone(baseProvider) as BaseProviderDefinition & { version?: unknown }
    delete profileCopy.version
    delete baseCopy.version
    return {
        schemaVersion: FRAGMENT_SCHEMA_VERSION,
        exportedAt: now,
        profile: profileCopy,
        baseProvider: baseCopy,
    }
}

export interface FragmentValidation {
    ok: boolean
    fragment?: ProfileFragment
    errors: string[]
}

/**
 * Validate a parsed (untrusted, possibly hand-edited) fragment. Since users
 * edit the JSON directly, broken input must fail loudly rather than corrupt the
 * store. Does NOT mutate; normalization for storage happens in `importFragment`.
 */
export function validateFragment(raw: unknown): FragmentValidation {
    const errors: string[] = []
    if (!isObject(raw)) return { ok: false, errors: ['Root is not a JSON object'] }

    const profile = raw['profile']
    const baseProvider = raw['baseProvider']
    if (!isObject(profile)) errors.push('Missing "profile" object')
    if (!isObject(baseProvider)) errors.push('Missing "baseProvider" object')
    if (errors.length > 0) return { ok: false, errors }

    const p = profile as Record<string, unknown>
    const b = baseProvider as Record<string, unknown>

    if (typeof p['id'] !== 'string' || p['id'].length === 0) errors.push('profile.id is required')
    // modelId may be empty (openai-compatible/custom profiles supply the model
    // elsewhere, e.g. via userValues) — only require that it is a string.
    if (typeof p['modelId'] !== 'string') errors.push('profile.modelId must be a string')
    if (!isObject(p['endpoint'])) errors.push('profile.endpoint is required')
    if (!isObject(p['auth'])) errors.push('profile.auth is required')
    if (!Array.isArray(p['schema'])) errors.push('profile.schema must be an array')
    if (typeof p['providerBaseId'] !== 'string') errors.push('profile.providerBaseId is required')

    if (typeof b['id'] !== 'string' || b['id'].length === 0) errors.push('baseProvider.id is required')
    if (!ADAPTER_KINDS.includes(b['adapterKind'] as AdapterKind)) {
        errors.push(`baseProvider.adapterKind must be one of: ${ADAPTER_KINDS.join(', ')}`)
    }
    if (!Array.isArray(b['requestSchema'])) errors.push('baseProvider.requestSchema must be an array')

    // The fragment must be self-contained: the profile references the bundled
    // baseProvider in the same file.
    if (typeof p['providerBaseId'] === 'string' && typeof b['id'] === 'string'
        && p['providerBaseId'] !== b['id']) {
        errors.push('profile.providerBaseId must match baseProvider.id (self-contained fragment)')
    }

    if (errors.length > 0) return { ok: false, errors }
    return { ok: true, fragment: raw as unknown as ProfileFragment, errors: [] }
}

/**
 * Normalize a validated fragment for storage and write it into the custom
 * registry. Returns the namespaced profile id and whether it overwrote an
 * existing custom profile (the caller confirms overwrite before calling).
 *
 *  - profile/baseProvider ids are forced into the `custom::` namespace so
 *    importing an edited copy of an official profile lands as a *new custom*
 *    profile rather than clobbering the official one.
 *  - profileUpdatedAt source (`updatedAt`) defaults to `now` when absent.
 */
export function importFragment(
    cache: RegistryCache,
    fragment: ProfileFragment,
    now: number,
): { profileId: string; overwritten: boolean } {
    const baseId = ensureCustomId(fragment.baseProvider.id)
    const profileId = ensureCustomId(fragment.profile.id)

    const baseProvider: BaseProviderDefinition = {
        ...fragment.baseProvider,
        id: baseId,
    }
    const profile: ModelProfile = {
        ...fragment.profile,
        id: profileId,
        providerBaseId: baseId,
        updatedAt: fragment.profile.updatedAt ?? now,
        profileStatus: fragment.profile.profileStatus ?? 'current',
    }
    // Imported legacy fragments may still contain the retired revision fields.
    delete (baseProvider as BaseProviderDefinition & { version?: unknown }).version
    delete (profile as ModelProfile & { version?: unknown }).version

    const registry = (cache.registries[CUSTOM_REGISTRY_ID] ??= {
        fetchedAt: now,
        profiles: {},
        baseProviders: {},
    })
    registry.profiles ??= {}
    registry.baseProviders ??= {}

    const overwritten = registry.profiles[profileId] !== undefined
    registry.profiles[profileId] = profile
    registry.baseProviders[baseId] = baseProvider
    registry.fetchedAt = now

    return { profileId, overwritten }
}

export type ProfileUpdateStatus = 'none' | 'updatable' | 'missing'

/**
 * Client-side update hint (custom-profiles plan §A/§3). Compares the timestamp
 * a preset recorded at creation/replace (`recordedUpdatedAt`) against the
 * current registry profile's `updatedAt`. Best-effort: only flags 'updatable'
 * when both timestamps are known and the registry copy is strictly newer.
 *   - 'missing'   → source profile no longer in the registry (offer re-pick)
 *   - 'updatable' → a newer revision exists (offer replace)
 *   - 'none'      → up to date / unknown
 */
export function getProfileUpdateStatus(
    current: ModelProfile | undefined,
    recordedUpdatedAt: number | undefined,
): ProfileUpdateStatus {
    if (!current) return 'missing'
    if (
        recordedUpdatedAt !== undefined
        && current.updatedAt !== undefined
        && current.updatedAt > recordedUpdatedAt
    ) {
        return 'updatable'
    }
    return 'none'
}

export interface MigrateUserValuesOptions {
    /** When supplied, values whose field type changed are dropped as incompatible. */
    currentSchema?: RegistryFieldSchema[]
    /** Profile replacement seeds defaults; snapshot repair/update leaves them implicit. */
    seedDefaults?: boolean
}

/**
 * Migrate userValues when a preset's profile schema changes:
 * keep compatible values whose key still exists, report the rest, and optionally
 * seed defaults for new fields.
 */
export function migrateUserValues(
    oldValues: Record<string, unknown> | undefined,
    newSchema: RegistryFieldSchema[],
    options: MigrateUserValuesOptions = {},
): { values: Record<string, unknown>; droppedKeys: string[] } {
    const newByKey = new Map(newSchema.map((f) => [f.key, f]))
    const currentByKey = new Map((options.currentSchema ?? []).map((f) => [f.key, f]))
    const values: Record<string, unknown> = {}
    const droppedKeys: string[] = []
    for (const [k, v] of Object.entries(oldValues ?? {})) {
        const nextField = newByKey.get(k)
        const currentField = currentByKey.get(k)
        if (!nextField || (currentField && currentField.type !== nextField.type)) {
            droppedKeys.push(k)
            continue
        }
        values[k] = v
    }
    if (options.seedDefaults !== false) {
        for (const f of newSchema) {
            if (f.default !== undefined && !(f.key in values)) values[f.key] = f.default
        }
    }
    return { values, droppedKeys }
}

/**
 * Build a self-contained fragment from a preset's resolved snapshot (for the
 * editor's "download" — the preset holds a merged snapshot, not a raw
 * profile+baseProvider). The merged schema is carried on the profile with a
 * minimal base provider; re-import re-merges to the same result.
 */
export function buildFragmentFromSnapshot(
    snapshot: ResolvedModelProfileSnapshot,
    displayName: string,
    now: number,
): ProfileFragment {
    const baseProvider: BaseProviderDefinition = {
        id: snapshot.providerBaseId,
        displayName: snapshot.providerBaseId,
        adapterKind: snapshot.adapterKind,
        // Tolerate an incomplete snapshot (auth/endpoint may be null on a
        // legacy/corrupted preset) so export degrades instead of crashing.
        authKinds: snapshot.auth ? [snapshot.auth.kind] : [],
        endpointKinds: snapshot.endpoint ? [snapshot.endpoint.kind] : [],
        requestSchema: [],
        uiSchema: { groups: [], fields: [] },
        sourceUrls: [],
    }
    const profile: ModelProfile = {
        id: snapshot.profileId,
        updatedAt: now,
        displayName,
        providerBaseId: snapshot.providerBaseId,
        profileStatus: 'current',
        modelId: snapshot.modelId,
        endpoint: snapshot.endpoint,
        auth: snapshot.auth,
        defaults: snapshot.defaults,
        schema: snapshot.schema,
        uiSchema: snapshot.uiSchema,
        bodyTemplate: snapshot.bodyTemplate,
        headerTemplate: snapshot.headerTemplate,
        capabilities: snapshot.capabilities,
        limits: snapshot.limits,
        recommendedTokenizer: snapshot.recommendedTokenizer,
        sourceUrls: [],
    }
    return buildProfileFragment(profile, baseProvider, now)
}

/** Remove a custom profile (and its base provider if now unreferenced). */
export function removeCustomProfile(cache: RegistryCache, profileId: string): void {
    const registry = cache.registries[CUSTOM_REGISTRY_ID]
    if (!registry?.profiles) return
    const profile = registry.profiles[profileId]
    if (!profile) return
    delete registry.profiles[profileId]
    const baseId = profile.providerBaseId
    const stillUsed = Object.values(registry.profiles).some((p) => p.providerBaseId === baseId)
    if (!stillUsed && registry.baseProviders) {
        delete registry.baseProviders[baseId]
    }
}

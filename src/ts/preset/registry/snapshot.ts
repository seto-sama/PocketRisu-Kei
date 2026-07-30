import type {
    BaseProviderDefinition,
    ModelProfile,
    RegistryCache,
    RegistryFieldSchema,
    RegistryUiField,
    RegistryUiSchema,
    ModelLimits,
    ResolvedModelProfileSnapshot,
} from '../types'

export class RegistryProfileNotFoundError extends Error {
    readonly profileId: string

    constructor(profileId: string) {
        super(`Registry profile "${profileId}" was not found. ` +
            `Refresh models.dev or import the custom profile again.`)
        this.name = 'RegistryProfileNotFoundError'
        this.profileId = profileId
    }
}

export class RegistryBaseProviderNotFoundError extends Error {
    readonly baseProviderId: string
    readonly profileId: string

    constructor(profileId: string, baseProviderId: string) {
        super(`Registry profile "${profileId}" references unknown base provider "${baseProviderId}".`)
        this.name = 'RegistryBaseProviderNotFoundError'
        this.profileId = profileId
        this.baseProviderId = baseProviderId
    }
}

export function resolveSnapshot(registry: RegistryCache, profileId: string): ResolvedModelProfileSnapshot {
    const { baseProvider, profile } = findProfile(registry, profileId)

    return {
        profileId: profile.id,
        providerBaseId: profile.providerBaseId,
        adapterKind: baseProvider.adapterKind,
        auth: profile.auth,
        endpoint: profile.endpoint,
        modelId: profile.modelId,
        schema: backfillSchemaDefaults(
            mergeSchemas(baseProvider.requestSchema, profile.schema),
            profile,
        ),
        uiSchema: mergeUiSchemas(baseProvider.uiSchema, profile.uiSchema),
        defaults: { ...(baseProvider.defaultBody ?? {}), ...profile.defaults },
        bodyTemplate: profile.bodyTemplate,
        headerTemplate: { ...(baseProvider.defaultHeaders ?? {}), ...(profile.headerTemplate ?? {}) },
        capabilities: profile.capabilities ?? baseProvider.capabilities,
        limits: mergeLimits(baseProvider.limits, profile.limits),
        recommendedTokenizer: profile.recommendedTokenizer,
    }
}

function mergeLimits(
    baseLimits: ModelLimits | undefined,
    profileLimits: ModelLimits | undefined,
): ModelLimits | undefined {
    if (!baseLimits) return profileLimits ? { ...profileLimits } : undefined
    if (!profileLimits) return { ...baseLimits }
    return { ...baseLimits, ...profileLimits }
}

function backfillSchemaDefaults(
    schema: RegistryFieldSchema[],
    profile: ModelProfile,
): RegistryFieldSchema[] {
    if (!profile.modelId) return schema
    return schema.map((field) => {
        if (field.key === 'modelId' && field.default === undefined) {
            return { ...field, default: profile.modelId }
        }
        return field
    })
}

function findProfile(
    registry: RegistryCache,
    profileId: string,
): { baseProvider: BaseProviderDefinition; profile: ModelProfile } {
    for (const entry of Object.values(registry.registries)) {
        const profile = entry.profiles?.[profileId]
        if (!profile) continue
        const baseProvider = entry.baseProviders?.[profile.providerBaseId]
        if (!baseProvider) {
            throw new RegistryBaseProviderNotFoundError(profileId, profile.providerBaseId)
        }
        return { baseProvider, profile }
    }
    throw new RegistryProfileNotFoundError(profileId)
}

function mergeSchemas(
    base: RegistryFieldSchema[],
    extension: RegistryFieldSchema[],
): RegistryFieldSchema[] {
    // Tolerate null/undefined array elements from malformed registry data so a
    // single bad entry can't crash resolution (reading `.key` of null).
    const safeBase = (base ?? []).filter(Boolean)
    const safeExt = (extension ?? []).filter(Boolean)
    if (safeExt.length === 0) return safeBase.slice()
    const merged: RegistryFieldSchema[] = []
    const overrideKeys = new Set(safeExt.map((f) => f.key))
    for (const field of safeBase) {
        if (!overrideKeys.has(field.key)) merged.push(field)
    }
    for (const field of safeExt) merged.push(field)
    return merged
}

function mergeUiSchemas(base: RegistryUiSchema, extension: RegistryUiSchema): RegistryUiSchema {
    // Tolerate null/undefined elements (malformed registry data) so a bad entry
    // can't crash resolution (reading `.key`/`.id` of null).
    const baseGroups = (base?.groups ?? []).filter(Boolean)
    const baseFields = (base?.fields ?? []).filter(Boolean)
    const extGroups = (extension?.groups ?? []).filter(Boolean)
    const extFields = (extension?.fields ?? []).filter(Boolean)
    if (extGroups.length === 0 && extFields.length === 0) {
        return { groups: baseGroups.slice(), fields: baseFields.slice() }
    }

    const groupIds = new Set(extGroups.map((g) => g.id))
    const groups = baseGroups.filter((g) => !groupIds.has(g.id)).concat(extGroups)

    const fieldKeys = new Set(extFields.map((f) => f.key))
    const fields: RegistryUiField[] = baseFields
        .filter((f) => !fieldKeys.has(f.key))
        .concat(extFields)

    return { groups, fields }
}

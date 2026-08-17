import type {
    BaseProviderDefinition,
    ModelProfile,
    RegistryCache,
} from '../types'

export interface ProviderFilterOption {
    id: string
    label: string
    profileCount: number
}

export const DEFAULT_VISIBLE_PROVIDER_IDS: ReadonlySet<string> = new Set([
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

/**
 * Resolve the persisted provider allowlist. Legacy databases stored the inverse
 * (hidden IDs), so use the current catalog to migrate that choice once.
 */
export function resolveProviderFilterVisibleIds(
    providerIds: Iterable<string>,
    storedVisibleProviderIds: readonly string[] | undefined,
    initialized: boolean,
    legacyHiddenProviderIds?: readonly string[],
): Set<string> {
    if (storedVisibleProviderIds) return new Set(storedVisibleProviderIds)

    const currentProviderIds = [...providerIds]
    if (initialized) {
        const hidden = new Set(legacyHiddenProviderIds ?? [])
        return new Set(currentProviderIds.filter(providerId => !hidden.has(providerId)))
    }
    return new Set(
        currentProviderIds.filter(providerId => DEFAULT_VISIBLE_PROVIDER_IDS.has(providerId)),
    )
}

/** Compatibility helper for consumers that filter by a hidden-ID set. */
export function resolveProviderFilterHiddenIds(
    providerIds: Iterable<string>,
    storedVisibleProviderIds: readonly string[] | undefined,
    initialized: boolean,
    legacyHiddenProviderIds?: readonly string[],
): Set<string> {
    const currentProviderIds = [...new Set(providerIds)]
    const visible = resolveProviderFilterVisibleIds(
        currentProviderIds,
        storedVisibleProviderIds,
        initialized,
        legacyHiddenProviderIds,
    )
    return new Set(currentProviderIds.filter(providerId => !visible.has(providerId)))
}

export function getProfileProviderGroup(
    profile: ModelProfile,
    baseProvider: BaseProviderDefinition | undefined,
): { id: string; label: string } {
    const id = baseProvider?.providerGroupId
        ?? baseProvider?.id
        ?? profile.providerBaseId
    const label = baseProvider?.providerGroupDisplayName
        ?? baseProvider?.displayName
        ?? id
    return { id, label }
}

/** Built-in Developer profiles are never affected by the models.dev filter. */
export function isAlwaysVisibleSpecialProfile(
    baseProvider: BaseProviderDefinition | undefined,
): boolean {
    return baseProvider?.adapterKind === 'echo' || baseProvider?.adapterKind === 'custom'
}

export function isProfileProviderVisible(
    profile: ModelProfile,
    baseProvider: BaseProviderDefinition | undefined,
    hiddenProviderIds: ReadonlySet<string>,
): boolean {
    if (isAlwaysVisibleSpecialProfile(baseProvider)) return true
    return !hiddenProviderIds.has(getProfileProviderGroup(profile, baseProvider).id)
}

export function listFilterableProviderGroups(
    registry: RegistryCache,
    registryId: string,
): ProviderFilterOption[] {
    const entry = registry.registries[registryId]
    if (!entry) return []

    const groups = new Map<string, ProviderFilterOption>()
    for (const profile of Object.values(entry.profiles ?? {})) {
        const baseProvider = entry.baseProviders?.[profile.providerBaseId]
        if (isAlwaysVisibleSpecialProfile(baseProvider)) continue

        const group = getProfileProviderGroup(profile, baseProvider)
        const existing = groups.get(group.id)
        if (existing) {
            existing.profileCount += 1
        } else {
            groups.set(group.id, {
                id: group.id,
                label: group.label,
                profileCount: 1,
            })
        }
    }

    return [...groups.values()].sort((a, b) =>
        a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    )
}

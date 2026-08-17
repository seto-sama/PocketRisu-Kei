import { getDatabase } from 'src/ts/storage/database.svelte'
import type { ApiKeyPoolEntry, BaseProviderDefinition } from './types'
import { v4 as uuidv4 } from 'uuid'

const API_KEY_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
    'cloudflare-workers-ai': 'cloudflare',
    'cloudflare-ai-gateway': 'cloudflare',
}

export interface ApiKeyProviderOption {
    id: string
    name: string
}

export function normalizeApiKeyProvider(provider: string | undefined): string | undefined {
    if (!provider) return undefined
    const withoutWireSuffix = provider.replace(/--(?:anthropic|responses)$/, '')
    return API_KEY_PROVIDER_ALIASES[withoutWireSuffix] ?? withoutWireSuffix
}

/**
 * Provider choices for the "new API key" form.
 *
 * Visibility is evaluated against the models.dev provider group before base
 * ids are normalized. This matters for collapsed credential scopes such as the
 * two Cloudflare providers: `cloudflare` remains available while either group
 * is visible. Voyage and NovelAI are not model-profile providers, so they are
 * always offered for their separate application features.
 */
export function listApiKeyProviderOptions(
    baseProviders: Record<string, BaseProviderDefinition>,
    hiddenProviderIds: ReadonlySet<string> = new Set(),
): ApiKeyProviderOption[] {
    const options = new Map<string, ApiKeyProviderOption>()
    for (const provider of Object.values(baseProviders)) {
        const groupId = provider.providerGroupId ?? provider.id
        if (hiddenProviderIds.has(groupId)) continue

        const id = normalizeApiKeyProvider(provider.id) ?? provider.id
        const name = id === 'cloudflare'
            ? 'Cloudflare'
            : provider.providerGroupDisplayName ?? provider.displayName
        if (!options.has(id)) options.set(id, { id, name })
    }

    options.set('voyage', { id: 'voyage', name: 'Voyage' })
    options.set('novelai', { id: 'novelai', name: 'NovelAI' })
    return [...options.values()].sort((a, b) =>
        a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    )
}

/**
 * Saved API key pool (db.apiKeyPool). A ModelPreset references an entry via
 * `apiKeyRef`; `buildModelPresetCredential` resolves apiKeyRef before any
 * inline/userValue key. Entries are tagged with `provider` (= the preset's
 * `profileSnapshot.providerBaseId`, normalized for providers that share
 * credentials) so the in-form picker can filter to the matching provider.
 *
 * Mutations reassign db.apiKeyPool to a fresh object — Svelte 5 no-ops a
 * same-reference assignment, so a new reference is required to trigger UI
 * reactivity for the pool manager and pickers.
 */

export function listApiKeys(provider?: string): ApiKeyPoolEntry[] {
    const pool = getDatabase().apiKeyPool ?? {}
    const all = Object.values(pool)
    const normalizedProvider = normalizeApiKeyProvider(provider)
    const filtered = normalizedProvider
        ? all.filter((e) => e.provider === normalizedProvider)
        : all
    return sortApiKeys(filtered)
}

/** First selectable saved key for a newly-created preset. */
export function getDefaultApiKeyRef(provider?: string): string | undefined {
    return listApiKeys(provider)[0]?.id
}

export function getApiKey(id: string | undefined): ApiKeyPoolEntry | undefined {
    if (!id) return undefined
    return getDatabase().apiKeyPool?.[id]
}

export function addApiKey(input: { name: string; key: string; provider?: string }): ApiKeyPoolEntry {
    const db = getDatabase()
    const pool = db.apiKeyPool ?? {}
    const now = Date.now()
    const maxOrder = Object.values(pool).reduce((max, entry) => {
        return typeof entry.order === 'number' && Number.isFinite(entry.order)
            ? Math.max(max, entry.order)
            : max
    }, -1)
    const entry: ApiKeyPoolEntry = {
        id: uuidv4(),
        name: input.name,
        provider: normalizeApiKeyProvider(input.provider),
        key: input.key,
        order: maxOrder + 1,
        createdAt: now,
        updatedAt: now,
    }
    db.apiKeyPool = { ...pool, [entry.id]: entry }
    return entry
}

export function updateApiKey(
    id: string,
    patch: Partial<Pick<ApiKeyPoolEntry, 'name' | 'key' | 'provider'>>,
): void {
    const db = getDatabase()
    const cur = db.apiKeyPool?.[id]
    if (!cur) return
    const normalizedPatch = patch.provider === undefined
        ? patch
        : { ...patch, provider: normalizeApiKeyProvider(patch.provider) }
    const next: ApiKeyPoolEntry = { ...cur, ...normalizedPatch, updatedAt: Date.now() }
    db.apiKeyPool = { ...(db.apiKeyPool ?? {}), [id]: next }
}

export function removeApiKey(id: string): void {
    const db = getDatabase()
    if (!db.apiKeyPool?.[id]) return
    const next = { ...db.apiKeyPool }
    delete next[id]
    db.apiKeyPool = next
}

export function reorderApiKeys(ids: string[]): void {
    const db = getDatabase()
    const pool = db.apiKeyPool
    if (!pool) return

    const next: Record<string, ApiKeyPoolEntry> = { ...pool }
    ids.forEach((id, index) => {
        const entry = next[id]
        if (!entry) return
        next[id] = { ...entry, order: index }
    })
    db.apiKeyPool = next
}

export function sortApiKeys(entries: ApiKeyPoolEntry[]): ApiKeyPoolEntry[] {
    return [...entries].sort((a, b) => {
        const ao = typeof a.order === 'number' && Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY
        const bo = typeof b.order === 'number' && Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY
        if (ao !== bo) return ao - bo
        if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
        return a.id.localeCompare(b.id)
    })
}

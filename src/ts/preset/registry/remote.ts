import { fetchNative } from 'src/ts/globalApi.svelte'
import { readPersistentJson, writePersistentJson } from 'src/ts/storage/persistentKv'
import { DBState } from 'src/ts/stores.svelte'
import type { ModelPreset, RegistryCache } from '../types'
import { getProfileUpdateStatus, type ProfileUpdateStatus } from '../customProfiles'
import { getOfficialRegistryId, loadSpecialRegistry } from './loader'
import { listFilterableProviderGroups, resolveProviderFilterVisibleIds } from './providerFilter'
import {
    buildModelsDevRegistry,
    MODELS_DEV_API_URL,
    type ModelsDevCatalog,
    validateModelsDevCatalog,
} from './modelsDev'

const MODELS_DEV_CACHE_KEY = 'model-presets/models-dev-v1.json'
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const LEGACY_OFFICIAL_REGISTRY_ID = 'bundled'

interface PersistedModelsDevCache {
    schemaVersion: 1
    fetchedAt: number
    contentHash: string
    catalog: ModelsDevCatalog
}

export interface SyncResult {
    ok: boolean
    changed: boolean
    downloaded?: boolean
    error?: string
}

let runtimeRegistry: RegistryCache | undefined
let runtimeCatalog: ModelsDevCatalog | undefined
let runtimeFetchedAt = 0
let runtimeHash: string | undefined
let hydratePromise: Promise<void> | undefined
let syncToken = 0

export function isRefetchGuarded(lastFetched: number | undefined): boolean {
    return lastFetched !== undefined && lastFetched > 0
        && Date.now() - lastFetched < REFRESH_INTERVAL_MS
}

export function isOfficialRegistryId(registryId: string | undefined): boolean {
    return registryId === getOfficialRegistryId() || registryId === LEGACY_OFFICIAL_REGISTRY_ID
}

async function hydrateRuntimeCache(): Promise<void> {
    if (!hydratePromise) {
        hydratePromise = (async () => {
            try {
                const cached = await readPersistentJson<PersistedModelsDevCache>(MODELS_DEV_CACHE_KEY)
                if (!cached
                    || cached.schemaVersion !== 1
                    || !Number.isFinite(cached.fetchedAt)
                    || typeof cached.contentHash !== 'string'
                    || !validateModelsDevCatalog(cached.catalog)) {
                    return
                }
                adoptCatalog(cached.catalog, cached.fetchedAt, cached.contentHash)
            } catch {
                // A broken cache must never hide built-in Developer profiles or
                // prevent a fresh network fetch.
            }
        })()
    }
    await hydratePromise
}

function adoptCatalog(catalog: ModelsDevCatalog, fetchedAt: number, contentHash: string): void {
    runtimeCatalog = catalog
    runtimeRegistry = buildModelsDevRegistry(catalog, fetchedAt)
    runtimeFetchedAt = fetchedAt
    runtimeHash = contentHash

    const providerIds = listFilterableProviderGroups(runtimeRegistry, getOfficialRegistryId())
        .map(provider => provider.id)
    const visibleProviderIds = resolveProviderFilterVisibleIds(
        providerIds,
        DBState.db.modelProfileVisibleProviderIds,
        DBState.db.modelProfileProviderFilterInitialized === true,
        DBState.db.modelProfileHiddenProviderIds,
    )
    DBState.db.modelProfileVisibleProviderIds = [...visibleProviderIds].sort()
    // The old inverse representation is no longer needed after the current
    // catalog has supplied the IDs required to migrate it.
    delete DBState.db.modelProfileHiddenProviderIds
    DBState.db.modelProfileProviderFilterInitialized = true

    // This DB field is only a tiny reactive revision marker. The catalog itself
    // lives in the dedicated persistent KV cache above, never in the main DB.
    DBState.db.modelProfileRegistryLastFetched = Math.max(
        Date.now(),
        (DBState.db.modelProfileRegistryLastFetched ?? 0) + 1,
    )
}

function mergeWithSpecial(registry: RegistryCache | undefined): RegistryCache {
    const registryId = getOfficialRegistryId()
    const special = loadSpecialRegistry().registries[registryId]
    const remote = registry?.registries[registryId]
    return {
        schemaVersion: 4,
        registries: {
            [registryId]: {
                fetchedAt: remote?.fetchedAt ?? 0,
                source: remote?.source,
                contentHash: remote?.contentHash,
                baseProviders: {
                    ...(remote?.baseProviders ?? {}),
                    ...(special?.baseProviders ?? {}),
                },
                profiles: {
                    ...(remote?.profiles ?? {}),
                    ...(special?.profiles ?? {}),
                },
            },
        },
    }
}

export async function syncRemoteRegistry(force = false): Promise<SyncResult> {
    try {
        await hydrateRuntimeCache()
        if (!force && runtimeRegistry && isRefetchGuarded(runtimeFetchedAt)) {
            return { ok: true, changed: false, downloaded: false }
        }

        const token = ++syncToken
        let response: Response
        try {
            response = await fetchNative(MODELS_DEV_API_URL, { method: 'GET' })
        } catch (error) {
            return {
                ok: false,
                changed: false,
                downloaded: false,
                error: `models.dev fetch failed: ${(error as Error).message}`,
            }
        }
        if (!response.ok) {
            return {
                ok: false,
                changed: false,
                downloaded: false,
                error: `models.dev fetch failed: HTTP ${response.status}`,
            }
        }

        const raw = await response.text()
        let catalog: unknown
        try {
            catalog = JSON.parse(raw)
        } catch {
            return { ok: false, changed: false, downloaded: true, error: 'models.dev returned invalid JSON' }
        }
        if (!validateModelsDevCatalog(catalog)) {
            return { ok: false, changed: false, downloaded: true, error: 'models.dev returned an unsupported catalog shape' }
        }
        if (token !== syncToken) {
            return { ok: true, changed: false, downloaded: false }
        }

        const fetchedAt = Date.now()
        const contentHash = hashText(raw)
        const changed = runtimeHash !== contentHash
        adoptCatalog(catalog, fetchedAt, contentHash)

        try {
            await writePersistentJson<PersistedModelsDevCache>(MODELS_DEV_CACHE_KEY, {
                schemaVersion: 1,
                fetchedAt,
                contentHash,
                catalog,
            })
        } catch {
            // Keep the freshly built in-memory catalog. A later app session can
            // fetch again if the separate cache could not be written.
        }

        return { ok: true, changed, downloaded: true }
    } catch (error) {
        return {
            ok: false,
            changed: false,
            downloaded: false,
            error: `models.dev sync failed: ${(error as Error).message}`,
        }
    }
}

/** Developer profiles return immediately; models.dev appears after hydration. */
export function getOfficialRegistry(): RegistryCache {
    // Establish Svelte's dependency on the revision marker assigned by
    // adoptCatalog(), without persisting the multi-megabyte catalog in DBState.
    void DBState.db.modelProfileRegistryLastFetched
    return mergeWithSpecial(runtimeRegistry)
}

/**
 * Returns the current raw models.dev catalog, hydrating the persistent cache
 * first when necessary. Pricing intentionally stays in this runtime catalog
 * instead of being copied into persisted model-preset snapshots.
 */
export async function getModelsDevCatalog(): Promise<ModelsDevCatalog | undefined> {
    await syncRemoteRegistry()
    return runtimeCatalog
}

export function getPresetUpdateStatus(preset: ModelPreset): ProfileUpdateStatus {
    const source = preset.sourceProfile
    if (!source?.registryId) return 'none'

    if (isOfficialRegistryId(source.registryId)) {
        const current = getOfficialRegistry().registries[getOfficialRegistryId()]
            ?.profiles?.[source.profileId]
        return getProfileUpdateStatus(current, source.profileUpdatedAt)
    }

    const current = DBState.db.modelProfileRegistryCache
        ?.registries?.[source.registryId]
        ?.profiles?.[source.profileId]
    return getProfileUpdateStatus(current, source.profileUpdatedAt)
}

function hashText(value: string): string {
    // Fast non-cryptographic content gate. It is only used to decide whether
    // update UI should refresh; catalog shape validation is the trust boundary.
    let hash = 0x811c9dc5
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`
}

/** Test-only reset; harmless in production and avoids exporting mutable state. */
export function resetModelsDevRuntimeForTests(): void {
    runtimeRegistry = undefined
    runtimeCatalog = undefined
    runtimeFetchedAt = 0
    runtimeHash = undefined
    hydratePromise = undefined
    syncToken = 0
}

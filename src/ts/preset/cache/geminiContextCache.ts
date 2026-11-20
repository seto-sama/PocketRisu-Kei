// Gemini cachedContents state, pure decisions, and REST client. State is
// mirrored to localStorage only; callers provide identity and auth, and client
// failures resolve as results so cache work cannot fail a chat request.

const STORAGE_KEY = 'pocketRisuGeminiCacheState'

// Repeated prefix mismatches disable caching for this chat session. API errors
// do not count, since transient cache failures should not disable future tries.
export const GEMINI_CACHE_INVALIDATION_LIMIT = 3

export const GEMINI_CACHE_DEFAULTS = {
    ttlSec: 600,
    extendTtlOnHit: true,
    minPromptTokens: 4096,
    growthTokens: 4096,
} as const

export interface GeminiPromptCachingConfig {
    enabled: boolean
    ttlSec?: number
    extendTtlOnHit?: boolean
    minPromptTokens?: number
    growthTokens?: number
}

export interface ResolvedGeminiCacheConfig {
    ttlSec: number
    extendTtlOnHit: boolean
    minPromptTokens: number
    growthTokens: number
}

// Null means caching is off; invalid overrides use defaults.
export function resolveGeminiCacheConfig(
    config: GeminiPromptCachingConfig | undefined | null,
): ResolvedGeminiCacheConfig | null {
    if (!config?.enabled) return null
    return {
        ttlSec: positiveOr(config.ttlSec, GEMINI_CACHE_DEFAULTS.ttlSec),
        extendTtlOnHit: config.extendTtlOnHit ?? GEMINI_CACHE_DEFAULTS.extendTtlOnHit,
        minPromptTokens: positiveOr(config.minPromptTokens, GEMINI_CACHE_DEFAULTS.minPromptTokens),
        growthTokens: positiveOr(config.growthTokens, GEMINI_CACHE_DEFAULTS.growthTokens),
    }
}

function positiveOr(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

// ─── runtime state store ────────────────────────────────────────────────────

export interface GeminiCacheStateEntry {
    cacheName: string               // "cachedContents/..."
    modelId: string
    createdAt: number
    expiresAt: number
    boundaryIndex: number           // contents count covered by the cache (= cachePoint position at creation)
    prefixHash: string              // hash(JSON({systemInstruction, contents[0..boundary)}))
    promptTokensAtCreation: number
    credentialFp: string            // key fingerprint — detects key-pool rotation
}

export function buildGeminiCacheKey(chatKey: string, task: string, presetId: string): string {
    return `${chatKey}::${task}::${presetId}`
}

let entries: Map<string, GeminiCacheStateEntry> | null = null
const invalidationCounts = new Map<string, number>()
const disabledSessions = new Set<string>()

function loadEntries(): Map<string, GeminiCacheStateEntry> {
    if (entries) return entries
    entries = new Map()
    const now = Date.now()
    try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
        if (raw) {
            const parsed: unknown = JSON.parse(raw)
            if (isPlainObject(parsed)) {
                for (const [key, value] of Object.entries(parsed)) {
                    if (!isValidEntry(value) || value.expiresAt <= now) continue
                    entries.set(key, value)
                }
            }
        }
    } catch {
        // unreadable / corrupt mirror → start empty
    }
    return entries
}

function persistEntries(): void {
    if (!entries) return
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
    } catch {
        // storage full / unavailable — in-memory Map stays authoritative
    }
}

function isValidEntry(value: unknown): value is GeminiCacheStateEntry {
    if (!isPlainObject(value)) return false
    return typeof value['cacheName'] === 'string'
        && typeof value['modelId'] === 'string'
        && typeof value['createdAt'] === 'number'
        && typeof value['expiresAt'] === 'number'
        && typeof value['boundaryIndex'] === 'number'
        && typeof value['prefixHash'] === 'string'
        && typeof value['promptTokensAtCreation'] === 'number'
        && typeof value['credentialFp'] === 'string'
}

// Expired entries are pruned on read so callers never see a stale cacheName.
export function getGeminiCacheEntry(key: string, now: number = Date.now()): GeminiCacheStateEntry | undefined {
    const store = loadEntries()
    const entry = store.get(key)
    if (entry && entry.expiresAt <= now) {
        store.delete(key)
        persistEntries()
        return undefined
    }
    return entry
}

export function setGeminiCacheEntry(key: string, entry: GeminiCacheStateEntry): void {
    loadEntries().set(key, entry)
    persistEntries()
}

export function removeGeminiCacheEntry(key: string): void {
    const store = loadEntries()
    if (store.delete(key)) persistEntries()
}

// Prefer the server expiry when constructing a fresh entry.
export function buildGeminiCacheEntry(args: {
    cacheName: string
    modelId: string
    now: number
    ttlSec: number
    expireTimeMs?: number
    boundaryIndex: number
    prefixHash: string
    promptTokensAtCreation: number
    credentialFp: string
}): GeminiCacheStateEntry {
    return {
        cacheName: args.cacheName,
        modelId: args.modelId,
        createdAt: args.now,
        expiresAt: args.expireTimeMs ?? args.now + args.ttlSec * 1000,
        boundaryIndex: args.boundaryIndex,
        prefixHash: args.prefixHash,
        promptTokensAtCreation: args.promptTokensAtCreation,
        credentialFp: args.credentialFp,
    }
}

// ─── session guards (in-memory only — reset on reload) ─────────────────────

export function getGeminiCacheInvalidationCount(key: string): number {
    loadEntries()
    return invalidationCounts.get(key) ?? 0
}

export function bumpGeminiCacheInvalidationCount(key: string): number {
    const next = getGeminiCacheInvalidationCount(key) + 1
    invalidationCounts.set(key, next)
    return next
}

export function resetGeminiCacheInvalidationCount(key: string): void {
    invalidationCounts.delete(key)
}

export function isGeminiCacheSessionDisabled(key: string): boolean {
    return disabledSessions.has(key)
}

// Disable for this session after repeated prefix mismatches or a cache-create
// 403, which indicates this project/key cannot use cachedContents.
export function disableGeminiCacheSession(key: string, reason = 'unrecoverable cache state'): void {
    if (disabledSessions.has(key)) return
    disabledSessions.add(key)
    console.warn(`[gemini-cache] context caching disabled for this chat session — ${reason} (${key}).`)
}

// Test-only: drop all in-memory state and force a localStorage reload.
export function resetGeminiContextCacheRuntime(): void {
    entries = null
    invalidationCounts.clear()
    disabledSessions.clear()
}

// ─── hashing ────────────────────────────────────────────────────────────────

// Stable, non-cryptographic digest for cache hashes.
function fnv1a32(text: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

// Hash the system instruction and contents before the cache boundary. Normalize
// an absent system instruction to null for stable serialization.
export function computeGeminiPrefixHash(
    systemInstruction: unknown,
    contents: readonly unknown[],
    boundaryIndex: number,
): string {
    return fnv1a32(JSON.stringify({
        systemInstruction: systemInstruction ?? null,
        contents: contents.slice(0, boundaryIndex),
    }))
}

// Bind entries to the credential that created them without storing the secret.
export function computeGeminiCredentialFp(credential: string): string {
    return fnv1a32(credential)
}

// ─── pure decisions: before request ─────────────────────────────────────────

export interface GeminiCachePreRequestInput {
    entry: GeminiCacheStateEntry | undefined
    now: number
    modelId: string
    credentialFp: string
    // Last native message.cachePoint position in the current contents
    // (count of contents before the boundary); null = no cache point.
    boundaryIndex: number | null
    systemInstruction: unknown      // body.systemInstruction (undefined when absent)
    contents: readonly unknown[]    // body.contents
}

export type GeminiCachePreDecision =
    // No cache point in the prompt → caching does not participate at all.
    | { action: 'bypass'; reason: 'no-cache-point' }
    // Send uncached; the post-response decision may create a cache.
    | { action: 'miss'; reason: 'no-state' | 'expired' | 'model-mismatch' | 'credential-mismatch' }
    // Stored cache no longer matches this prompt: remove state, DELETE the
    // remote cache (fire-and-forget), send uncached. countsTowardGuard is true
    // only for prefix-mismatch (the consecutive-invalidation auto-off guard).
    | {
        action: 'invalidate'
        reason: 'boundary-out-of-range' | 'prefix-mismatch'
        staleCacheName: string
        countsTowardGuard: boolean
    }
    // Valid cache → apply cachedContent + send only the suffix.
    | { action: 'apply'; cacheName: string; boundaryIndex: number }

export function evaluateGeminiCacheBeforeRequest(
    input: GeminiCachePreRequestInput,
): GeminiCachePreDecision {
    if (input.boundaryIndex === null) {
        return { action: 'bypass', reason: 'no-cache-point' }
    }
    const entry = input.entry
    if (!entry) return { action: 'miss', reason: 'no-state' }
    if (entry.expiresAt <= input.now) return { action: 'miss', reason: 'expired' }
    if (entry.modelId !== input.modelId) return { action: 'miss', reason: 'model-mismatch' }
    if (entry.credentialFp !== input.credentialFp) {
        return { action: 'miss', reason: 'credential-mismatch' }
    }
    if (entry.boundaryIndex > input.contents.length) {
        return {
            action: 'invalidate',
            reason: 'boundary-out-of-range',
            staleCacheName: entry.cacheName,
            countsTowardGuard: false,
        }
    }
    const prefixHash = computeGeminiPrefixHash(input.systemInstruction, input.contents, entry.boundaryIndex)
    if (prefixHash !== entry.prefixHash) {
        return {
            action: 'invalidate',
            reason: 'prefix-mismatch',
            staleCacheName: entry.cacheName,
            countsTowardGuard: true,
        }
    }
    return { action: 'apply', cacheName: entry.cacheName, boundaryIndex: entry.boundaryIndex }
}

// ─── pure decisions: after response ─────────────────────────────────────────

export interface GeminiCachePostResponseInput {
    pre: GeminiCachePreDecision
    // Entry as it stands AFTER pre-request handling (undefined when the pre
    // decision was 'invalidate' and the wiring removed it).
    entry: GeminiCacheStateEntry | undefined
    now: number
    promptTokens: number | undefined        // response usage (undefined = no usage observed)
    boundaryIndex: number | null            // last cachePoint of THIS request
    consecutiveInvalidations: number        // count after any pre-request bump
    config: ResolvedGeminiCacheConfig
}

export interface GeminiCachePostDecision {
    resetInvalidations: boolean             // confirmed hit
    disableSession: boolean                 // invalidation guard fired
    extendTtl: boolean                      // PATCH the current entry's ttl
    create: { boundaryIndex: number; replaceCacheName?: string } | null
    reason:
        | 'hit-fresh' | 'hit-extend' | 'hit-regrow'
        | 'no-usage' | 'below-min-tokens' | 'invalidation-guard' | 'no-cache-point' | 'create'
}

export function decideGeminiCacheAfterResponse(
    input: GeminiCachePostResponseInput,
): GeminiCachePostDecision {
    const { pre, entry, now, promptTokens, boundaryIndex, config } = input
    if (pre.action === 'apply' && entry) {
        // Recreate only when the cachePoint advances and the prompt crosses the
        // growth threshold; a larger suffix alone does not change the prefix.
        const boundaryAdvanced = boundaryIndex !== null && boundaryIndex > entry.boundaryIndex
        const grown = boundaryAdvanced
            && promptTokens !== undefined
            && promptTokens - entry.promptTokensAtCreation >= config.growthTokens
        if (grown && boundaryIndex !== null) {
            return {
                resetInvalidations: true,
                disableSession: false,
                extendTtl: false,
                create: { boundaryIndex, replaceCacheName: entry.cacheName },
                reason: 'hit-regrow',
            }
        }
        const extendTtl = config.extendTtlOnHit && entry.expiresAt - now < (config.ttlSec * 1000) / 2
        return {
            resetInvalidations: true,
            disableSession: false,
            extendTtl,
            create: null,
            reason: extendTtl ? 'hit-extend' : 'hit-fresh',
        }
    }
    // Bypass / miss / invalidated — consider creating a cache for next turn.
    if (promptTokens === undefined) return noCreate('no-usage')
    // Skip if even the whole prompt is below the minimum. The server checks
    // the actual cached prefix when creating the cache.
    if (promptTokens < config.minPromptTokens) return noCreate('below-min-tokens')
    if (input.consecutiveInvalidations >= GEMINI_CACHE_INVALIDATION_LIMIT) {
        return {
            resetInvalidations: false,
            disableSession: true,
            extendTtl: false,
            create: null,
            reason: 'invalidation-guard',
        }
    }
    if (boundaryIndex === null) return noCreate('no-cache-point')
    return {
        resetInvalidations: false,
        disableSession: false,
        extendTtl: false,
        create: { boundaryIndex, replaceCacheName: entry?.cacheName },
        reason: 'create',
    }
}

function noCreate(reason: 'no-usage' | 'below-min-tokens' | 'no-cache-point'): GeminiCachePostDecision {
    return { resetInvalidations: false, disableSession: false, extendTtl: false, create: null, reason }
}

// ─── body transforms (pure — inputs are not mutated) ────────────────────────

// Wire constraints with cachedContent set: contents must be the suffix past
// the cached boundary, and systemInstruction/tools/toolConfig must NOT repeat
// what the cache already holds.
export function applyGeminiCacheToBody(
    body: Record<string, unknown>,
    plan: { cacheName: string; boundaryIndex: number },
): Record<string, unknown> {
    const contents = Array.isArray(body['contents']) ? body['contents'] : []
    const next: Record<string, unknown> = { ...body }
    next['cachedContent'] = plan.cacheName
    next['contents'] = contents.slice(plan.boundaryIndex)
    delete next['systemInstruction']
    delete next['tools']
    delete next['toolConfig']
    return next
}

// The cache owns the system instruction and contents before the boundary.
// `model` uses the endpoint's resource shape: models/{id} on AI Studio and the
// full projects/.../publishers/google/models/{id} path on Vertex.
export function buildGeminiCacheCreateBody(args: {
    model: string
    ttlSec: number
    systemInstruction?: unknown
    contents: readonly unknown[]
    boundaryIndex: number
}): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: args.model,
        ttl: `${args.ttlSec}s`,
        contents: args.contents.slice(0, args.boundaryIndex),
    }
    if (args.systemInstruction !== undefined) {
        body['systemInstruction'] = args.systemInstruction
    }
    return body
}

// ─── cachedContents REST client ─────────────────────────────────────────────

// Vertex URLs include the publisher segment; cachedContents lives at the
// location root, so identify Vertex from its path rather than the host.
const VERTEX_PUBLISHER_MARKER = '/publishers/google/models'

// Derive the cachedContents collection from the chat URL; return null for
// unrecognized endpoint shapes.
export function deriveCachedContentsUrl(preparedUrl: string): string | null {
    // Check Vertex first because its path also contains "/models/".
    const vertexIdx = preparedUrl.indexOf(VERTEX_PUBLISHER_MARKER)
    if (vertexIdx >= 0) return `${preparedUrl.slice(0, vertexIdx)}/cachedContents`
    const marker = '/models/'
    const idx = preparedUrl.lastIndexOf(marker)
    if (idx >= 0) return `${preparedUrl.slice(0, idx)}/cachedContents`
    if (preparedUrl.endsWith('/models')) {
        return `${preparedUrl.slice(0, preparedUrl.length - '/models'.length)}/cachedContents`
    }
    return null
}

// Derive the model resource name in the endpoint's expected shape. Vertex uses
// the full URL path; AI Studio uses models/{modelId}.
export function deriveGeminiCacheModel(preparedUrl: string, modelId: string): string {
    const vertexIdx = preparedUrl.indexOf(VERTEX_PUBLISHER_MARKER)
    if (vertexIdx >= 0) {
        // Keep the complete Vertex resource path, without the generation method.
        const projectsIdx = preparedUrl.lastIndexOf('/projects/', vertexIdx)
        if (projectsIdx >= 0) {
            const afterSlash = preparedUrl.slice(projectsIdx + 1)
            const colonIdx = afterSlash.indexOf(':')
            const resource = colonIdx >= 0 ? afterSlash.slice(0, colonIdx) : afterSlash
            if (resource.length > 0) return resource
        }
    }
    return `models/${modelId}`
}

export interface GeminiCacheClientResult {
    ok: boolean
    status?: number
}

export interface GeminiCacheCreateResult extends GeminiCacheClientResult {
    name?: string           // "cachedContents/..."
    expireTimeMs?: number   // parsed from the RFC3339 expireTime, when present
}

export interface GeminiCachedContentsClient {
    create(body: Record<string, unknown>): Promise<GeminiCacheCreateResult>
    extend(cacheName: string, ttlSec: number): Promise<GeminiCacheClientResult>
    remove(cacheName: string): Promise<GeminiCacheClientResult>
}

// Use caller-provided auth headers; methods resolve results instead of throwing
// so fire-and-forget cache operations cannot fail the chat request.
export function createGeminiCachedContentsClient(opts: {
    cachedContentsUrl: string
    headers: Record<string, string>
    fetchImpl?: typeof fetch
}): GeminiCachedContentsClient {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch
    // Detect Vertex by its resource path so proxy endpoint hosts work too.
    const isVertex = /\/locations\/[^/]+\/cachedContents/.test(opts.cachedContentsUrl)
    const resourceUrl = (cacheName: string): string => {
        const id = cacheName.slice(cacheName.lastIndexOf('/') + 1)
        return `${opts.cachedContentsUrl}/${encodeURIComponent(id)}`
    }
    const call = async (url: string, method: string, body?: Record<string, unknown>): Promise<Response | null> => {
        try {
            return await fetchImpl(url, {
                method,
                headers: opts.headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            })
        } catch {
            return null
        }
    }
    return {
        async create(body) {
            const response = await call(opts.cachedContentsUrl, 'POST', body)
            if (!response) return { ok: false }
            if (!response.ok) return { ok: false, status: response.status }
            let raw: unknown
            try {
                raw = await response.json()
            } catch {
                return { ok: false, status: response.status }
            }
            if (!isPlainObject(raw) || typeof raw['name'] !== 'string') {
                return { ok: false, status: response.status }
            }
            const expireTime = typeof raw['expireTime'] === 'string' ? Date.parse(raw['expireTime']) : NaN
            return {
                ok: true,
                status: response.status,
                name: raw['name'],
                expireTimeMs: Number.isNaN(expireTime) ? undefined : expireTime,
            }
        },
        async extend(cacheName, ttlSec) {
            // Vertex requires updateMask=ttl; AI Studio does not.
            const url = isVertex
                ? `${resourceUrl(cacheName)}?updateMask=ttl`
                : resourceUrl(cacheName)
            const response = await call(url, 'PATCH', { ttl: `${ttlSec}s` })
            if (!response) return { ok: false }
            return { ok: response.ok, status: response.status }
        },
        async remove(cacheName) {
            const response = await call(resourceUrl(cacheName), 'DELETE')
            if (!response) return { ok: false }
            return { ok: response.ok, status: response.status }
        },
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

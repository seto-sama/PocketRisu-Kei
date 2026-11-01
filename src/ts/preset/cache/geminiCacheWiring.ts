// Orchestrates cache decisions and background side effects for googleGemini.
// Failures degrade to an uncached request and never interrupt chat generation.

import type { AdapterCacheContext } from '../adapter/types'
import {
    applyGeminiCacheToBody,
    buildGeminiCacheCreateBody,
    buildGeminiCacheEntry,
    buildGeminiCacheKey,
    bumpGeminiCacheInvalidationCount,
    computeGeminiCredentialFp,
    computeGeminiPrefixHash,
    createGeminiCachedContentsClient,
    decideGeminiCacheAfterResponse,
    deriveCachedContentsUrl,
    deriveGeminiCacheModel,
    disableGeminiCacheSession,
    evaluateGeminiCacheBeforeRequest,
    getGeminiCacheEntry,
    getGeminiCacheInvalidationCount,
    isGeminiCacheSessionDisabled,
    removeGeminiCacheEntry,
    resetGeminiCacheInvalidationCount,
    resolveGeminiCacheConfig,
    setGeminiCacheEntry,
    type GeminiCachedContentsClient,
    type GeminiCachePreDecision,
    type ResolvedGeminiCacheConfig,
} from './geminiContextCache'

export interface GeminiCacheTurn {
    // Request body to send; cache transforms do not mutate the input body.
    body: Record<string, unknown>
    // True when the adapter should retry an applied-cache rejection uncached.
    appliedCache: boolean
    // Drop a rejected cache before the adapter retries uncached.
    invalidateAppliedCache(): void
    // Start background cache work using observed prompt-token usage, if present.
    finish(promptTokens: number | undefined): void
}

const pendingCacheTasks = new Set<Promise<void>>()

function trackCacheTask(task: Promise<unknown>): void {
    const observed = task.then(
        () => undefined,
        err => console.warn('[gemini-cache] background step failed', err),
    )
    pendingCacheTasks.add(observed)
    void observed.finally(() => pendingCacheTasks.delete(observed))
}

/** Waits until all cache side effects already in flight have settled. */
export async function settleGeminiCacheTasks(): Promise<void> {
    while (pendingCacheTasks.size > 0) {
        await Promise.all([...pendingCacheTasks])
    }
}

export function beginGeminiCacheTurn(args: {
    cache: AdapterCacheContext
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
    modelId: string
    credentialKey: string | undefined
    boundaryIndex: number | null
    fetchImpl?: typeof fetch
}): GeminiCacheTurn | null {
    try {
        return beginTurn(args)
    } catch (err) {
        console.warn('[gemini-cache] skipped for this request (pre-request step failed)', err)
        return null
    }
}

function beginTurn(args: Parameters<typeof beginGeminiCacheTurn>[0]): GeminiCacheTurn | null {
    const config = resolveGeminiCacheConfig(args.cache.promptCaching)
    if (!config) return null
    // A native cachePoint is required to define the cached prefix.
    if (args.boundaryIndex === null) return null
    // Tool-enabled requests are not cacheable; also guard against custom bodies.
    if (args.body.tools !== undefined || args.body.toolConfig !== undefined) return null
    const key = buildGeminiCacheKey(args.cache.chatKey, args.cache.task, args.cache.presetId)
    if (isGeminiCacheSessionDisabled(key)) return null
    const cachedContentsUrl = deriveCachedContentsUrl(args.url)
    if (!cachedContentsUrl) return null
    // The cache resource model must use the same Studio or Vertex shape as the
    // chat URL.
    const cacheModel = deriveGeminiCacheModel(args.url, args.modelId)

    const client = createGeminiCachedContentsClient({
        cachedContentsUrl,
        headers: args.headers,
        fetchImpl: args.fetchImpl,
    })
    const now = Date.now()
    // Credential rotation must not reuse a cache created with another credential.
    const credentialFp = computeGeminiCredentialFp(args.credentialKey ?? '')
    const contents = Array.isArray(args.body.contents) ? (args.body.contents as unknown[]) : []
    const systemInstruction = args.body.systemInstruction

    const pre = evaluateGeminiCacheBeforeRequest({
        entry: getGeminiCacheEntry(key, now),
        now,
        modelId: args.modelId,
        credentialFp,
        boundaryIndex: args.boundaryIndex,
        systemInstruction,
        contents,
    })

    // Newer turns supersede pending writes from earlier turns for this cache key.
    const generation = bumpCacheKeyGeneration(key)

    let body = args.body
    let appliedCache = false
    if (pre.action === 'invalidate') {
        // Drop stale state and delete remotely; only prefix mismatches count
        // toward the session auto-disable guard.
        if (pre.countsTowardGuard) bumpGeminiCacheInvalidationCount(key)
        removeGeminiCacheEntry(key)
        trackCacheTask(client.remove(pre.staleCacheName))
    } else if (pre.action === 'apply') {
        // Gemini requires non-empty contents. Keep the cache for a later turn
        // when this prompt has no suffix beyond its boundary.
        if (pre.boundaryIndex >= contents.length) return null
        body = applyGeminiCacheToBody(args.body, pre)
        appliedCache = true
    }

    return {
        body,
        appliedCache,
        invalidateAppliedCache: () => {
            // Drop an applied cache rejected by the server before uncached retry.
            if (!appliedCache || pre.action !== 'apply') return
            removeGeminiCacheEntry(key)
            trackCacheTask(client.remove(pre.cacheName))
        },
        finish: (promptTokens) => {
            trackCacheTask(runPostResponse({
                key,
                generation,
                pre,
                client,
                config,
                modelId: args.modelId,
                cacheModel,
                credentialFp,
                systemInstruction,
                contents,
                boundaryIndex: args.boundaryIndex,
                promptTokens,
            }))
        },
    }
}

// Per-key generations prevent a late create/extend from an older turn from
// restoring state after a newer turn has invalidated or replaced it.
const cacheKeyGeneration = new Map<string, number>()

function bumpCacheKeyGeneration(key: string): number {
    const next = (cacheKeyGeneration.get(key) ?? 0) + 1
    cacheKeyGeneration.set(key, next)
    return next
}

function isCacheKeyGenerationCurrent(key: string, generation: number): boolean {
    return (cacheKeyGeneration.get(key) ?? 0) === generation
}

// Test-only: drop the per-key generation map so each test starts clean.
export function resetGeminiCacheWiringRuntime(): void {
    cacheKeyGeneration.clear()
    pendingCacheTasks.clear()
}

// Apply the pure post-response decision in the background. Commit state only
// while this turn's generation is still current.
async function runPostResponse(args: {
    key: string
    generation: number
    pre: GeminiCachePreDecision
    client: GeminiCachedContentsClient
    config: ResolvedGeminiCacheConfig
    modelId: string
    cacheModel: string   // resource-name shape of modelId for the create body (Studio vs Vertex)
    credentialFp: string
    systemInstruction: unknown
    contents: readonly unknown[]
    boundaryIndex: number | null
    promptTokens: number | undefined
}): Promise<void> {
    const now = Date.now()
    const entry = getGeminiCacheEntry(args.key, now)
    const post = decideGeminiCacheAfterResponse({
        pre: args.pre,
        entry,
        now,
        promptTokens: args.promptTokens,
        boundaryIndex: args.boundaryIndex,
        consecutiveInvalidations: getGeminiCacheInvalidationCount(args.key),
        config: args.config,
    })
    if (post.resetInvalidations) resetGeminiCacheInvalidationCount(args.key)
    if (post.disableSession) disableGeminiCacheSession(args.key)
    if (post.extendTtl && entry) {
        const result = await args.client.extend(entry.cacheName, args.config.ttlSec)
        // Mirror the new expiry only if no newer turn superseded this update.
        if (result.ok && isCacheKeyGenerationCurrent(args.key, args.generation)) {
            setGeminiCacheEntry(args.key, { ...entry, expiresAt: now + args.config.ttlSec * 1000 })
        }
    }
    if (post.create) {
        const boundaryIndex = post.create.boundaryIndex
        const result = await args.client.create(buildGeminiCacheCreateBody({
            model: args.cacheModel,
            ttlSec: args.config.ttlSec,
            systemInstruction: args.systemInstruction,
            contents: args.contents,
            boundaryIndex,
        }))
        // Ignore stale results. Delete an orphan create, and do not let an old
        // 403 disable the current session.
        if (!isCacheKeyGenerationCurrent(args.key, args.generation)) {
            if (result.ok && result.name) await args.client.remove(result.name)
            return
        }
        if (!result.ok || !result.name) {
            // A create 403 disables this session; other failures are recoverable
            // and only skip caching for this turn.
            if (result.status === 403) {
                disableGeminiCacheSession(args.key, 'cache creation returned 403 (project/key cannot use cachedContents)')
            }
            console.warn('[gemini-cache] cache creation failed', result.status)
            return
        }
        setGeminiCacheEntry(args.key, buildGeminiCacheEntry({
            cacheName: result.name,
            modelId: args.modelId,
            now,
            ttlSec: args.config.ttlSec,
            expireTimeMs: result.expireTimeMs,
            boundaryIndex,
            prefixHash: computeGeminiPrefixHash(args.systemInstruction, args.contents, boundaryIndex),
            promptTokensAtCreation: args.promptTokens ?? 0,
            credentialFp: args.credentialFp,
        }))
        // Register the replacement before deleting the prior cache.
        if (post.create.replaceCacheName) await args.client.remove(post.create.replaceCacheName)
    }
}

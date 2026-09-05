import { ModelPresetAdapterError } from '../error'
import { DEFAULT_SCOPE, type ParsedServiceAccount } from './serviceAccount'
import {
    type AccessTokenResult,
    type ExchangeServiceAccountInput,
} from './token'

const REFRESH_SKEW_SECONDS = 60

export interface GetAccessTokenInput {
    serviceAccount: ParsedServiceAccount
    scope?: string
    abortSignal?: AbortSignal
}

export interface ResolvedAccessToken {
    accessToken: string
    tokenType: string
    expiresAtMs: number
}

export interface ServiceAccountTokenCacheOptions {
    now?: () => number
    exchange: (input: ExchangeServiceAccountInput) => Promise<AccessTokenResult>
}

export interface ServiceAccountTokenCache {
    getAccessToken(input: GetAccessTokenInput): Promise<ResolvedAccessToken>
    clear(): void
}

interface CacheEntry {
    token?: ResolvedAccessToken
    inflight?: Promise<ResolvedAccessToken>
}

export function createServiceAccountTokenCache(
    options: ServiceAccountTokenCacheOptions,
): ServiceAccountTokenCache {
    const now = options.now ?? Date.now
    const exchange = options.exchange
    const entries = new Map<string, CacheEntry>()

    function cacheKey(sa: ParsedServiceAccount, scope: string): string {
        return `${sa.tokenUri}|${sa.clientEmail}|${scope}`
    }

    function isFresh(token: ResolvedAccessToken): boolean {
        return token.expiresAtMs - now() > REFRESH_SKEW_SECONDS * 1000
    }

    function fetchAndStore(
        key: string,
        serviceAccount: ParsedServiceAccount,
        scope: string,
    ): Promise<ResolvedAccessToken> {
        const entry = entries.get(key) ?? {}
        // The shared refresh deliberately runs without a caller-supplied
        // AbortSignal. Token refresh is a shared resource — aborting it because
        // *one* caller cancelled would also fail every other in-flight caller
        // and waste the work. Caller-level cancellation is handled in
        // `getAccessToken` via a race against the caller's signal.
        const promise = exchange({
            serviceAccount,
            scope,
            now,
        }).then(
            (result) => {
                const resolved: ResolvedAccessToken = {
                    accessToken: result.accessToken,
                    tokenType: result.tokenType,
                    expiresAtMs: result.issuedAtMs + result.expiresInSeconds * 1000,
                }
                entries.set(key, { token: resolved })
                return resolved
            },
            (err) => {
                // Failure: drop the inflight reference so the next caller
                // retries. Preserve any previously-stored stale token; it will
                // fail the isFresh check on the next call and trigger a new
                // exchange anyway.
                const current = entries.get(key)
                if (current?.inflight === entry.inflight) {
                    entries.set(key, { token: current.token })
                }
                throw err
            },
        )
        entry.inflight = promise
        entries.set(key, entry)
        // Defensive: every caller may race against an AbortSignal that wins,
        // leaving the shared promise without any rejection handler attached
        // when the exchange later fails. An attached no-op .catch keeps the
        // original rejection from bubbling to the global unhandledRejection
        // handler; the original error still flows to every awaiter through
        // the `.then` chain above and to whichever raceWithAbort caller
        // resolves first.
        promise.catch(() => undefined)
        return promise
    }

    async function getAccessToken(input: GetAccessTokenInput): Promise<ResolvedAccessToken> {
        // Pre-aborted callers reject immediately without ever starting a new
        // token exchange. This matters even when the cache is cold: kicking
        // off a `fetchAndStore` only to throw the result away would still
        // burn a token exchange call.
        if (input.abortSignal?.aborted) {
            throw makeAbortError()
        }
        const scope = input.scope && input.scope.length > 0 ? input.scope : DEFAULT_SCOPE
        const key = cacheKey(input.serviceAccount, scope)
        const existing = entries.get(key)
        const shared: Promise<ResolvedAccessToken> = existing?.inflight
            ?? (existing?.token && isFresh(existing.token)
                ? Promise.resolve(existing.token)
                : fetchAndStore(key, input.serviceAccount, scope))
        return raceWithAbort(shared, input.abortSignal)
    }

    return {
        getAccessToken,
        clear() {
            entries.clear()
        },
    }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(makeAbortError())
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort)
            reject(makeAbortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort)
                resolve(value)
            },
            (err) => {
                signal.removeEventListener('abort', onAbort)
                reject(err)
            },
        )
    })
}

function makeAbortError(): ModelPresetAdapterError {
    return new ModelPresetAdapterError('aborted', 'Service account token request aborted', {
        retryable: false,
        fallbackEligible: false,
    })
}

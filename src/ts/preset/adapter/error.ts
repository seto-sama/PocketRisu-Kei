import type { AdapterError, AdapterErrorKind } from './types'

export interface AdapterErrorOptions {
    status?: number
    retryAfterMs?: number
    retryable?: boolean
    fallbackEligible?: boolean
    cause?: unknown
}

export class ModelPresetAdapterError extends Error {
    readonly kind: AdapterErrorKind
    readonly status?: number
    readonly retryAfterMs?: number
    readonly retryable: boolean
    readonly fallbackEligible: boolean

    constructor(kind: AdapterErrorKind, message: string, options: AdapterErrorOptions = {}) {
        super(message)
        this.name = 'ModelPresetAdapterError'
        this.kind = kind
        this.status = options.status
        this.retryAfterMs = options.retryAfterMs
        this.retryable = options.retryable ?? defaultRetryable(kind)
        this.fallbackEligible = options.fallbackEligible ?? defaultFallbackEligible(kind)
        if (options.cause !== undefined) {
            ;(this as Error & { cause?: unknown }).cause = options.cause
        }
    }

    toAdapterError(): AdapterError {
        return {
            kind: this.kind,
            message: this.message,
            status: this.status,
            ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
            retryable: this.retryable,
            fallbackEligible: this.fallbackEligible,
            cause: (this as Error & { cause?: unknown }).cause,
        }
    }
}

export function defaultRetryable(kind: AdapterErrorKind): boolean {
    switch (kind) {
        case 'network':
        case 'timeout':
        case 'rate-limit':
        case 'server':
        case 'parse':
            return true
        default:
            return false
    }
}

// Distinct from `retryable`: this is the policy for switching to a fallback
// ModelPreset (plan §9-8). 429/rate-limit can be retried in place but is
// not a fallback trigger by policy.
export function defaultFallbackEligible(kind: AdapterErrorKind): boolean {
    switch (kind) {
        case 'network':
        case 'timeout':
        case 'server':
        case 'parse':
            return true
        default:
            return false
    }
}

export function normalizeFetchError(err: unknown): ModelPresetAdapterError {
    if (err instanceof ModelPresetAdapterError) return err
    if (err instanceof Error) {
        if (err.name === 'AbortError') {
            return new ModelPresetAdapterError('aborted', err.message || 'Request aborted', {
                retryable: false,
                cause: err,
            })
        }
        return new ModelPresetAdapterError('network', err.message || 'Network error', {
            cause: err,
        })
    }
    return new ModelPresetAdapterError('unknown', String(err))
}

/**
 * Best-effort error message extractor for vendor JSON error bodies. Handles
 * the common shapes:
 *  - `{ error: { message } }` — OpenAI-compatible, Anthropic Messages, Google AI Studio
 *  - `{ message }`            — bare-message responses
 *  - `{ error_description }`  — Google OAuth token endpoint (RFC 6749 §5.2)
 *  - `{ error }` (string)     — Google OAuth error code (e.g. "invalid_grant")
 *
 * Returns the first match in priority order, or a truncated raw body if the
 * payload is not JSON, or `null` if JSON parsed but no known field matched.
 */
export function extractErrorMessage(bodyText: string): string | null {
    if (!bodyText) return null
    try {
        const parsed = JSON.parse(bodyText) as {
            error?: { message?: unknown } | unknown
            message?: unknown
            error_description?: unknown
        }
        if (
            typeof parsed?.error === 'object'
            && parsed.error !== null
            && typeof (parsed.error as { message?: unknown }).message === 'string'
        ) {
            return (parsed.error as { message: string }).message
        }
        if (typeof parsed?.message === 'string') return parsed.message
        if (typeof parsed?.error_description === 'string') {
            // Google OAuth: include the error code alongside the description
            // when both are present, so the caller sees both `invalid_grant`
            // and the human-readable reason.
            if (typeof parsed.error === 'string') {
                return `${parsed.error}: ${parsed.error_description}`
            }
            return parsed.error_description
        }
        if (typeof parsed?.error === 'string') return parsed.error
    } catch {
        return bodyText.slice(0, 200)
    }
    return null
}

export function normalizeHttpStatus(
    status: number,
    message?: string,
    options: Pick<AdapterErrorOptions, 'retryAfterMs'> = {},
): ModelPresetAdapterError | null {
    if (status >= 200 && status < 300) return null
    if (status === 401 || status === 403) {
        return new ModelPresetAdapterError('auth', message ?? `HTTP ${status}`, {
            status,
            ...options,
            retryable: false,
        })
    }
    if (status === 404) {
        return new ModelPresetAdapterError('not-found', message ?? `HTTP ${status}`, {
            status,
            ...options,
            retryable: false,
        })
    }
    if (status === 408) {
        return new ModelPresetAdapterError('timeout', message ?? `HTTP ${status}`, { status, ...options })
    }
    if (status === 429) {
        return new ModelPresetAdapterError('rate-limit', message ?? `HTTP ${status}`, { status, ...options })
    }
    if (status >= 400 && status < 500) {
        return new ModelPresetAdapterError('invalid-request', message ?? `HTTP ${status}`, {
            status,
            ...options,
            retryable: false,
        })
    }
    if (status >= 500 && status < 600) {
        return new ModelPresetAdapterError('server', message ?? `HTTP ${status}`, { status, ...options })
    }
    return new ModelPresetAdapterError('unknown', message ?? `HTTP ${status}`, { status, ...options })
}

/** Parses either Retry-After delta-seconds or an HTTP date into milliseconds. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
    const trimmed = value?.trim()
    if (!trimmed) return undefined

    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
        const seconds = Number(trimmed)
        return Number.isFinite(seconds) && seconds >= 0
            ? Math.ceil(seconds * 1_000)
            : undefined
    }

    const timestamp = Date.parse(trimmed)
    if (!Number.isFinite(timestamp)) return undefined
    return Math.max(0, timestamp - now)
}

const TRANSIENT_OVERLOAD_PATTERN = /(?:\bhttp\s+(?:429|503|529)\b|too many requests|rate[\s_-]*limit|resource[_\s-]*exhausted|overload(?:ed)?)/i

export function isTransientOverloadMessage(message: string): boolean {
    return TRANSIENT_OVERLOAD_PATTERN.test(message)
}

/** Normalize provider errors delivered inside an otherwise successful stream. */
export function normalizeProviderStreamError(
    payload: unknown,
    fallbackMessage: string,
): ModelPresetAdapterError {
    const value = payload && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : {}
    const message = typeof value.message === 'string' ? value.message : fallbackMessage
    const status = [value.status, value.status_code, value.http_status]
        .find(candidate => typeof candidate === 'number') as number | undefined
    if (status !== undefined) {
        const normalized = normalizeHttpStatus(status, message)
        if (normalized) return normalized
    }

    const providerCode = [value.code, value.type]
        .filter(candidate => typeof candidate === 'string')
        .join(' ')
    if (isTransientOverloadMessage(`${providerCode} ${message}`)) {
        return new ModelPresetAdapterError('rate-limit', message, { status })
    }
    if (/(?:server|internal|service[\s_-]*unavailable)/i.test(providerCode)) {
        return new ModelPresetAdapterError('server', message, { status })
    }
    return new ModelPresetAdapterError('unknown', message, { status })
}

export interface RequestRetryFailure {
    failByServerError?: boolean
    retryAfterMs?: number
}

const OVERLOAD_JITTER_RATIO = 0.2

/** Base backoff for the one-based retry attempt. */
export function overloadRetryBaseDelayMs(retryAttempt: number): number {
    if (retryAttempt <= 3) return 1_000
    if (retryAttempt <= 5) return 5_000
    return 10_000
}

/**
 * Returns the delay for the next retry, or null when the retry budget is spent.
 * Overload jitter is additive so the configured tier remains a minimum delay.
 */
export function requestRetryDelayMs(
    failure: RequestRetryFailure,
    retryAttempt: number,
    maxRetries: number,
    random: () => number = Math.random,
): number | null {
    const retryBudget = Number.isFinite(maxRetries)
        ? Math.max(0, Math.floor(maxRetries))
        : 0
    if (retryAttempt < 1 || retryAttempt > retryBudget) return null
    if (!failure.failByServerError) return 0

    if (Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs! >= 0) {
        return Math.ceil(failure.retryAfterMs!)
    }

    const baseDelayMs = overloadRetryBaseDelayMs(retryAttempt)
    const jitter = Math.floor(baseDelayMs * OVERLOAD_JITTER_RATIO * Math.max(0, Math.min(1, random())))
    return baseDelayMs + jitter
}

import { isTransientOverloadMessage } from '../preset/adapter/error'

type GenerationFailure = {
    failByServerError?: boolean
    kind?: unknown
    status?: unknown
    result?: unknown
    message?: unknown
}

/** Transient provider saturation is already represented by request status. */
export function shouldSuppressGenerationErrorModal(failure: unknown): boolean {
    if (!failure) return false
    if (typeof failure === 'string') return isTransientOverloadMessage(failure)
    if (typeof failure !== 'object') return false

    const value = failure as GenerationFailure
    if (value.failByServerError) return true
    if (value.kind === 'rate-limit') return true
    if (value.status === 429 || value.status === 503 || value.status === 529) return true

    const message = typeof value.message === 'string'
        ? value.message
        : typeof value.result === 'string'
            ? value.result
            : ''
    return isTransientOverloadMessage(message)
}

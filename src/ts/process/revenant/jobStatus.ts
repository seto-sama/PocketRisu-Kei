import type { RevenantJobStatus } from './types'

export type RevenantTerminalRequestOutcome = 'done' | 'failed' | 'aborted'

/**
 * Maps the durable provider-job terminal state to every client-facing request
 * status. Keeping this independent of transport/recovery prevents live streams
 * and recovered streams from disagreeing about completion versus cancellation.
 */
export function revenantTerminalRequestOutcome(
    status: RevenantJobStatus | undefined,
): RevenantTerminalRequestOutcome | undefined {
    if (status === 'generated') return 'done'
    if (status === 'cancelled') return 'aborted'
    if (status === 'interrupted' || status === 'failed_partial' || status === 'failed') {
        return 'failed'
    }
    return undefined
}

export function resolveRevenantTerminalRequestOutcome(
    localOutcome: RevenantTerminalRequestOutcome,
    status: RevenantJobStatus | undefined,
): RevenantTerminalRequestOutcome {
    const durableOutcome = revenantTerminalRequestOutcome(status)
    // Cancellation/failure is authoritative even when the provider byte stream
    // itself reached a clean EOF. A generated provider job does not mask a
    // later client-side tool/parser failure in the enclosing request.
    if (durableOutcome === 'aborted' || durableOutcome === 'failed') {
        return durableOutcome
    }
    return localOutcome
}

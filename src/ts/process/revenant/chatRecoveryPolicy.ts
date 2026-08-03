import type { RevenantJobStatus } from './types'

export type ClientActionRecoveryMode = 'none' | 'blocking' | 'background'

export function clientActionRecoveryMode(
    hasWaitingClientStep: boolean,
    recoverableMainJobCount: number,
): ClientActionRecoveryMode {
    if (!hasWaitingClientStep) return 'none'
    return recoverableMainJobCount > 0 ? 'background' : 'blocking'
}

export type MainRecoveryStatusAction = 'start' | 'done' | 'failed' | 'aborted' | 'none'

export function mainRecoveryStatusAction(
    status: RevenantJobStatus,
    wasObserved: boolean,
): MainRecoveryStatusAction {
    if (status === 'queued' || status === 'generating') return 'start'
    if (!wasObserved) return 'none'
    if (status === 'generated') return 'done'
    if (status === 'cancelled') return 'aborted'
    return 'failed'
}

import type { RevenantJobStatus } from './types'

export const MAIN_JOB_REGISTRATION_GRACE_MS = 5000

/**
 * Prompt preprocessing is local-only. The workflow is created after the prompt
 * is complete, immediately before the main job is registered. This grace only
 * covers those adjacent server calls; it never authorizes another client to
 * rebuild the prompt or submit the provider request.
 */
export function shouldWaitForMainJobRegistration(
    workflowCreatedAt: number,
    now = Date.now(),
): boolean {
    return now - workflowCreatedAt < MAIN_JOB_REGISTRATION_GRACE_MS
}

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

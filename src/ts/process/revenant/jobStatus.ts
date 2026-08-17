import type { RevenantGenerationTerminal, RevenantJobStatus } from './types'
import {
    appendText,
    endStatus,
    hasRequestStatus,
    observeText,
    startStatus,
    type EndStatusUsage,
    type RequestKind,
} from '../../status/requestStatus'

export type RevenantTerminalRequestOutcome = 'done' | 'failed' | 'aborted'

interface RevenantRequestStatusSession {
    jobId: string
    statusId: string
    workflowId?: string
    roomId: string
    kind: RequestKind
}

const requestStatusSessions = new Map<string, RevenantRequestStatusSession>()
const terminalWorkflowOutcomes = new Map<string, {
    outcome: RevenantTerminalRequestOutcome
    endedAt: number
}>()
const MAX_TERMINAL_WORKFLOW_OUTCOMES = 256

function rememberTerminalWorkflow(
    workflowId: string,
    outcome: RevenantTerminalRequestOutcome,
    endedAt: number,
): void {
    terminalWorkflowOutcomes.delete(workflowId)
    terminalWorkflowOutcomes.set(workflowId, { outcome, endedAt })
    while (terminalWorkflowOutcomes.size > MAX_TERMINAL_WORKFLOW_OUTCOMES) {
        const oldest = terminalWorkflowOutcomes.keys().next().value
        if (oldest === undefined) break
        terminalWorkflowOutcomes.delete(oldest)
    }
}

export function registerRevenantRequestStatus(input: {
    jobId: string
    statusId: string
    workflowId?: string
    roomId: string
    kind: RequestKind
    label?: string
    startedAt: number
}): void {
    const session: RevenantRequestStatusSession = {
        jobId: input.jobId,
        statusId: input.statusId,
        workflowId: input.workflowId,
        roomId: input.roomId,
        kind: input.kind,
    }
    requestStatusSessions.set(input.jobId, session)
    if (!hasRequestStatus(input.statusId)) {
        startStatus(input.statusId, {
            kind: input.kind,
            label: input.label ?? '',
            chatId: input.roomId,
            phase: 'connecting',
            now: input.startedAt,
        })
    }
    const terminal = input.workflowId
        ? terminalWorkflowOutcomes.get(input.workflowId)
        : undefined
    if (terminal) {
        endStatus(input.statusId, terminal.outcome, { now: terminal.endedAt })
        requestStatusSessions.delete(input.jobId)
    }
}

export function finishRevenantJobRequestStatus(
    jobId: string,
    terminal: RevenantGenerationTerminal,
    fallbackStatusId?: string,
    usage?: EndStatusUsage,
): void {
    const session = requestStatusSessions.get(jobId)
    const statusId = session?.statusId ?? fallbackStatusId
    const outcome = revenantTerminalRequestOutcome(terminal.status) ?? 'done'
    if (statusId) {
        endStatus(statusId, outcome, {
            now: Date.now(),
            usage,
            ...(outcome === 'failed' && terminal.finishReason
                ? { error: terminal.finishReason }
                : {}),
        })
    }
    requestStatusSessions.delete(jobId)
}

export function appendRevenantJobRequestText(
    jobId: string,
    delta: { thinking?: string, response?: string },
    now = Date.now(),
): boolean {
    const session = requestStatusSessions.get(jobId)
    if (!session) return false
    appendText(session.statusId, delta, now)
    return true
}

export function observeRevenantJobRequestText(
    jobId: string,
    text: { thinking?: string, response?: string },
    now = Date.now(),
): boolean {
    const session = requestStatusSessions.get(jobId)
    if (!session) return false
    observeText(session.statusId, text, now)
    return true
}

export function finishRevenantWorkflowRequestStatuses(input: {
    workflowId: string
    roomId: string
    outcome: RevenantTerminalRequestOutcome
    endedAt?: number
}): void {
    const endedAt = input.endedAt ?? Date.now()
    rememberTerminalWorkflow(input.workflowId, input.outcome, endedAt)
    for (const [jobId, session] of requestStatusSessions) {
        if (session.workflowId !== input.workflowId || session.roomId !== input.roomId) continue
        endStatus(session.statusId, input.outcome, { now: endedAt })
        requestStatusSessions.delete(jobId)
    }
}

export function finishRevenantChatRequestStatuses(
    roomId: string,
    outcome: RevenantTerminalRequestOutcome,
    endedAt = Date.now(),
): void {
    for (const [jobId, session] of requestStatusSessions) {
        if (session.roomId !== roomId || session.kind !== 'main') continue
        endStatus(session.statusId, outcome, { now: endedAt })
        requestStatusSessions.delete(jobId)
    }
}

export function resetRevenantRequestStatusSessionsForTest(): void {
    requestStatusSessions.clear()
    terminalWorkflowOutcomes.clear()
}

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

/** Compose terminal observation once for every live request backend. */
export function bindRevenantTerminalOutcome(target: {
    onRevenantTerminal?: (terminal: RevenantGenerationTerminal) => void
}) {
    let durableStatus: RevenantJobStatus | undefined
    const caller = target.onRevenantTerminal
    target.onRevenantTerminal = terminal => {
        durableStatus = terminal.status
        caller?.(terminal)
    }
    return {
        resolve(localOutcome: RevenantTerminalRequestOutcome) {
            return resolveRevenantTerminalRequestOutcome(localOutcome, durableStatus)
        },
    }
}

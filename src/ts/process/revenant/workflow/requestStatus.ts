import { getDatabase } from '../../../storage/database.svelte'
import { hasRequestStatus, requestStatusIdForJob, type RequestKind } from '../../../status/requestStatus'
import { finishRevenantJobRequestStatus, finishRevenantWorkflowRequestStatuses, registerRevenantRequestStatus } from '../jobStatus'
import type { RevenantWorkflowRequestJob } from '../types'
import { getRevenantWorkflowRequestStatus } from './workflow'

const observations = new Set<string>()

function requestKind(job: RevenantWorkflowRequestJob): RequestKind {
    switch (job.jobType) {
        case 'model': return 'main'
        case 'memory': return 'memory'
        case 'translate': return 'translate'
        case 'emotion': return 'emotion'
        default: return 'sub'
    }
}

export function updateWorkflowRequestStatus(job: RevenantWorkflowRequestJob): void {
    const statusId = requestStatusIdForJob(job)
    if (job.status === 'queued') return
    if (job.status === 'generating') {
        registerRevenantRequestStatus({
            jobId: job.jobId, statusId, workflowId: job.workflowId,
            roomId: job.roomId, kind: requestKind(job), label: job.generationInfo?.model,
            startedAt: job.dispatchedAt ?? job.createdAt,
        })
    }
    else if (hasRequestStatus(statusId)) {
        finishRevenantJobRequestStatus(job.jobId, {
            status: job.status, finishReason: job.error,
        }, statusId)
    }
}

/** One lifecycle snapshot for all provider requests in this workflow. */
export function observeRevenantWorkflowRequests(workflowId: string, signal?: AbortSignal): void {
    if (getDatabase().showRequestStatus === false || observations.has(workflowId)) return
    observations.add(workflowId)
    void (async () => {
        while (!signal?.aborted) {
            const snapshot = await getRevenantWorkflowRequestStatus(workflowId, signal)
            if (signal?.aborted) return
            snapshot.jobs.forEach(updateWorkflowRequestStatus)
            if (snapshot.status !== 'active') {
                finishRevenantWorkflowRequestStatuses({
                    workflowId, roomId: snapshot.roomId,
                    outcome: snapshot.status === 'completed' ? 'done'
                        : snapshot.status === 'cancelled' ? 'aborted' : 'failed',
                })
                return
            }
            await new Promise(resolve => setTimeout(resolve, 500))
        }
    })().catch(error => {
        if (!signal?.aborted) console.warn('[GenerationJob] Workflow request status unavailable:', error)
    }).finally(() => observations.delete(workflowId))
}

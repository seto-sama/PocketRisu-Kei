import { getDatabase } from '../../../storage/database.svelte'
import { getCurrentImageGenerationPreset } from '../../../imageGeneration/presets'
import { endStatus, setStatusProgress, startStatus } from '../../../status/requestStatus'
import type { RevenantWorkflow } from '../types'
import { createRevenantGenerationAuth } from '../transport/client'
import { getRevenantWorkflow } from './workflow'
import { serviceComfyBridgeJob, type ComfyBridgeJobStatus } from './comfyBridge'

interface ServerImageJobStatus extends ComfyBridgeJobStatus {
    progress?: { value: number, max: number, node?: string }
    error?: string
}

const observations = new Map<string, Promise<RevenantWorkflow>>()
const serverActionObservations = new Set<string>()

async function readServerImageJob(jobId: string): Promise<ServerImageJobStatus | undefined> {
    const headers = { 'risu-auth': await createRevenantGenerationAuth() }
    const response = await fetch(`/api/image-generation/jobs/${encodeURIComponent(jobId)}`, { headers })
    if (!response.ok) return undefined
    const job = await response.json() as ServerImageJobStatus
    if (job.provider === 'comfyui' && job.bridgeRequest
        && (job.status === 'waiting_client' || job.status === 'generating')) {
        void serviceComfyBridgeJob(jobId, job).catch(() => {})
    }
    return job
}

export function observeRevenantServerImageActions(workflow: RevenantWorkflow): void {
    if (workflow.context?.kind === 'image-generation') return
    for (const step of workflow.steps) {
        if (step.status !== 'running') continue
        const action = step.metadata?.action as { actionId?: unknown, kind?: unknown } | undefined
        if (action?.kind !== 'image.generate' || typeof action.actionId !== 'string') continue
        const jobId = `${workflow.workflowId}:${action.actionId}`
        if (serverActionObservations.has(jobId)) continue
        serverActionObservations.add(jobId)
        const statusId = jobId
        const reportStatus = getDatabase().showRequestStatus !== false
        if (reportStatus) {
            startStatus(statusId, {
                kind: 'image',
                label: getCurrentImageGenerationPreset(getDatabase()).name,
                chatId: workflow.roomId,
                phase: 'connecting',
                now: Date.now(),
            })
        }
        void (async () => {
            while (true) {
                const job = await readServerImageJob(jobId)
                if (!job) {
                    const latest = await getRevenantWorkflow(workflow.workflowId).catch(() => undefined)
                    if (latest && latest.status !== 'active') {
                        const failedStep = latest.steps.find(item => item.status === 'failed')
                        if (reportStatus) endStatus(statusId, latest.status === 'cancelled' ? 'aborted' : 'failed', {
                            now: Date.now(),
                            error: String(failedStep?.metadata?.error || `Image workflow ${latest.status}`),
                        })
                        break
                    }
                    await new Promise(resolve => setTimeout(resolve, 500))
                    continue
                }
                if (reportStatus && job.progress) setStatusProgress(statusId, job.progress)
                if (job.status === 'queued' || job.status === 'waiting_client' || job.status === 'generating') {
                    await new Promise(resolve => setTimeout(resolve, 500))
                    continue
                }
                if (reportStatus) endStatus(statusId, job.status === 'completed' ? 'done' : 'failed', {
                    now: Date.now(),
                    error: job.error,
                })
                break
            }
        })().finally(() => serverActionObservations.delete(jobId))
    }
}

async function observe(
    initial: RevenantWorkflow,
    onActivate?: () => void,
): Promise<RevenantWorkflow> {
    const context = initial.context
    if (context?.kind !== 'image-generation') return initial
    const step = initial.steps.find(item => item.key === 'image.generate')
    const action = step?.metadata?.action as { actionId?: unknown } | undefined
    const actionId = typeof action?.actionId === 'string' ? action.actionId : ''
    if (!actionId) throw new Error('Image workflow has no server action')
    const jobId = `${initial.workflowId}:${actionId}`
    const statusId = context.operationId
    const reportStatus = getDatabase().showRequestStatus !== false
    if (reportStatus) {
        startStatus(statusId, {
            kind: 'image',
            label: context.label,
            chatId: context.messageId,
            phase: 'connecting',
            now: Date.now(),
            onActivate,
        })
    }
    let workflow = initial
    let jobCompleted = false
    while (workflow.status === 'active') {
        if (!jobCompleted) {
            const job = await readServerImageJob(jobId)
            if (reportStatus && job?.progress) setStatusProgress(statusId, job.progress)
            if (job?.status === 'failed' || job?.status === 'interrupted') {
                const error = job.error || `Image generation ${job.status}`
                if (reportStatus) endStatus(statusId, 'failed', { now: Date.now(), error })
                throw new Error(error)
            }
            if (job?.status !== 'completed') {
                // A 404 is possible for a few milliseconds while the server
                // scheduler creates the durable image job. Check the workflow
                // in that case; otherwise the job status is the cheaper poll.
                if (!job) workflow = await getRevenantWorkflow(initial.workflowId)
                if (workflow.status === 'active') await new Promise(resolve => setTimeout(resolve, 500))
                continue
            }
            jobCompleted = true
        }
        workflow = await getRevenantWorkflow(initial.workflowId)
        if (workflow.status === 'active') await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (workflow.status === 'completed') {
        if (reportStatus) endStatus(statusId, 'done', { now: Date.now() })
        return workflow
    }
    const failedStep = workflow.steps.find(item => item.status === 'failed')
    const error = String(failedStep?.metadata?.error || `Image workflow ${workflow.status}`)
    if (reportStatus) endStatus(statusId, workflow.status === 'cancelled' ? 'aborted' : 'failed', {
        now: Date.now(),
        error,
    })
    throw new Error(error)
}

export function observeRevenantImageGenerationWorkflow(
    workflow: RevenantWorkflow,
    onActivate?: () => void,
): Promise<RevenantWorkflow> {
    const running = observations.get(workflow.workflowId)
    if (running) return running
    const promise = observe(workflow, onActivate)
        .finally(() => observations.delete(workflow.workflowId))
    observations.set(workflow.workflowId, promise)
    return promise
}

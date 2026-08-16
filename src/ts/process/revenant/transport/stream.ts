import {
    createRevenantCancellationHeaders,
    createRevenantGenerationAuth,
    getRevenantGenerationMetadata,
    getRevenantGenerationSyncClientId,
    setRevenantGenerationLocallyObserved,
    trackRevenantGenerationJob,
    trackRevenantGenerationWorkflow,
} from './client'
import { decodeRevenantGenerationJournal } from './journalDecoder'
import { openRevenantJournalSocket } from './journalSocket'
import type {
    RecoverableAuxiliaryJob,
    RecoverableGenerationJob,
    RevenantGenerationRequest,
    RevenantGenerationTerminal,
} from '../types'

type RecoverableJournalJob = RecoverableGenerationJob | RecoverableAuxiliaryJob

const defaultGenerationHeartbeatSec = 15

export class GenerationJobRegistrationError extends Error {
    constructor(
        readonly status: number,
        detail: string,
    ) {
        super(`Failed to create generation job: ${status} ${detail}`)
        this.name = 'GenerationJobRegistrationError'
    }
}

export function subscribeRecoverableGeneration(
    job: RecoverableGenerationJob,
    handlers: {
        onContent: (content: string) => void
        onDone: () => void
        onError?: (error: unknown) => void
    },
): () => void {
    const controller = new AbortController()
    void openRecoverableJournalStream(job, controller.signal)
        .then(stream => decodeRevenantGenerationJournal(job, stream, handlers.onContent))
        .then(() => {
            if (!controller.signal.aborted) handlers.onDone()
        })
        .catch(error => {
            if (!controller.signal.aborted) handlers.onError?.(error)
        })

    return () => {
        controller.abort()
    }
}

export async function readRecoverableGenerationContent(
    job: RecoverableJournalJob,
): Promise<string> {
    if (job.projection?.content) return job.projection.content
    const stream = await openRecoverableJournalStream(job)
    try {
        return await decodeRevenantGenerationJournal(job, stream)
    }
    catch (error) {
        // Interrupted journals can end inside an SSE/JSON frame. The last
        // normalized client projection is still a valid partial recovery.
        if (job.projection?.content) return job.projection.content
        throw error
    }
}

async function openRecoverableJournalStream(
    job: RecoverableJournalJob,
    signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
    const auth = await createRevenantGenerationAuth()
    return openRevenantJournalSocket({
        jobId: job.jobId,
        auth,
        signal,
        recovery: true,
        onHeaders(status, headers) {
            job.responseStatus = status
            job.responseHeaders = headers
        },
    })
}

export async function fetchViaGenerationJob(url: string, arg: {
    method: string
    headers: Record<string, string>
    body?: Uint8Array
    signal?: AbortSignal
    requestTimeoutMs?: number
    onJobCreated?: (jobId: string) => void
    onProviderStarted?: (startedAt: number) => void
    onTerminal?: (terminal: RevenantGenerationTerminal) => void
    generationRequest: RevenantGenerationRequest
}): Promise<Response> {
    const auth = await createRevenantGenerationAuth()
    const bodyBase64 = arg.body ? Buffer.from(arg.body).toString('base64') : ''

    const jobRes = await fetch('/api/generation/jobs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'risu-auth': auth,
            'x-sync-client-id': getRevenantGenerationSyncClientId(),
        },
        body: JSON.stringify({
            url,
            method: arg.method,
            headers: arg.headers,
            bodyBase64,
            timeoutMs: arg.requestTimeoutMs,
            heartbeatSec: defaultGenerationHeartbeatSec,
            ...arg.generationRequest.job,
            workflowId: arg.generationRequest.workflow?.workflowId,
            workflowStepKey: arg.generationRequest.workflow?.stepKey,
            workflowStepExecutionId: arg.generationRequest.workflow?.executionId,
            workflowDependency: arg.generationRequest.workflow?.dependency,
            workflowClientAction: arg.generationRequest.workflow?.clientAction,
            ...(arg.generationRequest.job.chatId
                ? getRevenantGenerationMetadata(arg.generationRequest.job.chatId)
                : undefined),
        }),
        signal: arg.signal,
    })

    if (!jobRes.ok) {
        throw new GenerationJobRegistrationError(jobRes.status, await jobRes.text())
    }

    const { jobId } = await jobRes.json() as { jobId: string }
    arg.onJobCreated?.(jobId)
    setRevenantGenerationLocallyObserved(jobId, true)
    trackRevenantGenerationWorkflow(jobId, arg.generationRequest.workflow?.workflowId)
    if (arg.generationRequest.job.jobType === 'model' && arg.generationRequest.job.chatId) {
        trackRevenantGenerationJob(arg.generationRequest.job.chatId, jobId)
    }
    return openGenerationJobResponse(
        jobId,
        auth,
        arg.signal,
        arg.onProviderStarted,
        arg.onTerminal,
        !arg.generationRequest.workflow?.workflowId,
    )
}

async function deleteGenerationJob(jobId: string): Promise<void> {
    return fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: await createRevenantCancellationHeaders(),
    }).then(() => {}, () => {})
}

function openGenerationJobResponse(
    jobId: string,
    auth: string,
    signal?: AbortSignal,
    onProviderStarted?: (startedAt: number) => void,
    onTerminal?: (terminal: RevenantGenerationTerminal) => void,
    cancelJobOnAbort = true,
): Promise<Response> {
    return new Promise((resolve, reject) => {
        let settled = false
        const stream = openRevenantJournalSocket({
            jobId,
            auth,
            signal,
            onProviderStarted,
            onHeaders(status, headers) {
                if (settled) return
                settled = true
                resolve(new Response(stream, {
                    status,
                    headers: {
                        ...headers,
                        'x-risu-revenant-generation': '1',
                        'x-risu-generation-job-id': jobId,
                    },
                }))
            },
            onFatal(error) {
                setRevenantGenerationLocallyObserved(jobId, false)
                if (settled) return
                settled = true
                reject(error)
            },
            onDone(terminal) {
                setRevenantGenerationLocallyObserved(jobId, false)
                onTerminal?.(terminal)
                if (settled) return
                settled = true
                reject(new Error('Generation ended before provider response headers'))
            },
            signalAction: cancelJobOnAbort ? 'cancel_job' : undefined,
            onDetached() {
                setRevenantGenerationLocallyObserved(jobId, false)
            },
            onCancelRequested() {
                if (cancelJobOnAbort) void deleteGenerationJob(jobId)
            },
        })
    })
}

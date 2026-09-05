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
    AdapterUsage,
} from '../../../preset/adapter/types'
import type {
    RecoverableAuxiliaryJob,
    RecoverableGenerationJob,
    RevenantGenerationRequest,
    RevenantGenerationTerminal,
    RevenantJobCreatedHandler,
} from '../types'

type RecoverableJournalJob = RecoverableGenerationJob | RecoverableAuxiliaryJob

const defaultGenerationHeartbeatSec = 15

interface RecoveryProjectionSnapshot {
    content: string
    progress?: {
        thinking: string
        response: string
        usage?: AdapterUsage
    }
}

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
        onProgress?: (progress: { thinking: string, response: string, usage?: AdapterUsage }) => void
        onProviderStarted?: (startedAt: number) => void
        onDone: (terminal?: RevenantGenerationTerminal, usage?: AdapterUsage) => void
        onError?: (error: unknown) => void
    },
): () => void {
    const controller = new AbortController()
    let terminal: RevenantGenerationTerminal | undefined
    let usage: AdapterUsage | undefined
    let latestContent = ''
    let latestProgress: RecoveryProjectionSnapshot['progress']
    let catchingUp = true
    const publishSnapshot = (snapshot: RecoveryProjectionSnapshot) => {
        if (snapshot.progress) handlers.onProgress?.(snapshot.progress)
        if (snapshot.content) handlers.onContent(snapshot.content)
    }
    const queueContent = (content: string) => {
        latestContent = content
        if (catchingUp) return
        handlers.onContent(content)
    }
    const finishCatchUp = () => {
        if (!catchingUp || controller.signal.aborted) return
        catchingUp = false
        publishSnapshot({ content: latestContent, progress: latestProgress })
    }
    const flushLatest = () => {
        if (catchingUp) finishCatchUp()
    }
    void openRecoverableJournalStream(job, controller.signal, value => {
        terminal = value
    }, () => finishCatchUp(), handlers.onProviderStarted)
        .then(stream => decodeRevenantGenerationJournal(
            job,
            stream,
            queueContent,
            progress => {
                if (progress.usage) usage = progress.usage
                latestProgress = progress
                if (!catchingUp) handlers.onProgress?.(progress)
            },
        ))
        .then(() => {
            if (!controller.signal.aborted) {
                flushLatest()
                handlers.onDone(terminal, usage)
            }
        })
        .catch(error => {
            if (!controller.signal.aborted) {
                // Preserve the newest complete projection decoded before a
                // truncated/interrupted journal tail failed.
                flushLatest()
                handlers.onError?.(error)
            }
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
    onTerminal?: (terminal: RevenantGenerationTerminal) => void,
    onSnapshotConsumed?: () => void,
    onProviderStarted?: (startedAt: number) => void,
): Promise<ReadableStream<Uint8Array>> {
    const auth = await createRevenantGenerationAuth()
    const snapshotResponse = await fetch(
        `/api/generation/jobs/${encodeURIComponent(job.jobId)}/journal/snapshot`,
        { headers: { 'risu-auth': auth }, signal },
    )
    if (!snapshotResponse.ok) {
        throw new Error(`Failed to read generation journal snapshot: ${snapshotResponse.status}`)
    }
    const snapshot = new Uint8Array(await snapshotResponse.arrayBuffer())
    const snapshotOffset = Number(snapshotResponse.headers.get('x-risu-journal-offset'))
    if (!Number.isSafeInteger(snapshotOffset) || snapshotOffset < 0
        || snapshotOffset !== snapshot.length) {
        throw new Error('Invalid generation journal snapshot offset')
    }
    const liveStream = openRevenantJournalSocket({
        jobId: job.jobId,
        auth,
        signal,
        recovery: true,
        initialOffset: snapshotOffset,
        onDone: onTerminal,
        onProviderStarted,
        onHeaders(status, headers) {
            job.responseStatus = status
            job.responseHeaders = headers
        },
    })
    const liveReader = liveStream.getReader()
    let snapshotDelivered = false
    let snapshotConsumed = false
    // With no prefetch, the second pull cannot run until the decoder has fully
    // processed the snapshot chunk (including every SSE/AWS event it contains).
    // That gives us an exact one-render snapshot boundary while the same
    // decoder retains any incomplete trailing frame for the live bytes.
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (!snapshotDelivered) {
                snapshotDelivered = true
                if (snapshot.length > 0) {
                    controller.enqueue(snapshot)
                    return
                }
            }
            if (!snapshotConsumed) {
                snapshotConsumed = true
                onSnapshotConsumed?.()
            }
            const next = await liveReader.read()
            if (next.done) controller.close()
            else controller.enqueue(next.value)
        },
        cancel(reason) {
            return liveReader.cancel(reason)
        },
    }, { highWaterMark: 0 })
}

export async function fetchViaGenerationJob(url: string, arg: {
    method: string
    headers: Record<string, string>
    body?: Uint8Array
    signal?: AbortSignal
    requestTimeoutMs?: number
    onJobCreated?: RevenantJobCreatedHandler
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

    const { jobId, createdAt } = await jobRes.json() as {
        jobId?: unknown
        createdAt?: unknown
    }
    if (
        typeof jobId !== 'string'
        || typeof createdAt !== 'number'
        || !Number.isFinite(createdAt)
    ) {
        throw new Error('Invalid generation job registration response')
    }
    arg.onJobCreated?.(jobId, createdAt)
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

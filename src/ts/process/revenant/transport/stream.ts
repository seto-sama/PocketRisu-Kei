import { BINARY_MESSAGE_CONTENT_TYPE, encodeGenerationRequest } from './protocol'
import {
    createRevenantCancellationHeaders,
    createRevenantGenerationAuth,
    getRevenantGenerationMetadata,
    getRevenantGenerationSyncClientId,
    setRevenantGenerationLocallyObserved,
    trackRevenantGenerationJob,
    trackRevenantGenerationWorkflow,
} from './client'
import { openRevenantJournalSocket } from './journalSocket'
import {
    createDecodedChatProjection,
    readDecodedChatEvents,
    type DecodedChatProgress,
} from '../../../preset/adapter/decodedEvents'
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
import { observeRevenantWorkflowRequests } from '../workflow/requestStatus'
import { localizedApiErrorMessage, readApiErrorPayload } from 'src/ts/network/apiError'

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
        readonly code?: string,
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
        .then(stream => foldRecoverableEvents(
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
                // Preserve the newest projection folded before the stream failed.
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
    return foldRecoverableEvents(job, await openRecoverableJournalStream(job))
}

/** Folds a job's server-decoded events into the message text. */
async function foldRecoverableEvents(
    job: RecoverableJournalJob,
    stream: ReadableStream<Uint8Array>,
    onContent?: (content: string) => void,
    onProgress?: (progress: DecodedChatProgress) => void,
): Promise<string> {
    if (job.responseStatus !== undefined
        && (job.responseStatus < 200 || job.responseStatus >= 300)) {
        await stream.cancel()
        throw new Error(`Provider request failed with HTTP ${job.responseStatus}`)
    }
    // A provider round completed by the client (tool loop) replaces the raw turn.
    if (job.projection?.source === 'provider') {
        await stream.cancel()
        const content = job.projection.content
        onContent?.(content)
        onProgress?.({ thinking: '', response: content })
        return content
    }
    const projection = createDecodedChatProjection()
    for await (const event of readDecodedChatEvents(stream)) {
        projection.apply(event)
        onProgress?.(projection.progress())
        const content = projection.content()
        if (content) onContent?.(content)
    }
    return projection.content() || (job.projection?.content ?? '')
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
        `/api/generation/jobs/${encodeURIComponent(job.jobId)}/journal/snapshot?format=events`,
        { headers: { 'risu-auth': auth }, signal },
    )
    if (!snapshotResponse.ok) {
        throw new Error(`Failed to read generation journal snapshot: ${snapshotResponse.status}`)
    }
    let snapshot: Uint8Array | undefined = new Uint8Array(await snapshotResponse.arrayBuffer())
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
        format: 'events',
        initialOffset: snapshotOffset,
        onDone: onTerminal,
        onProviderStarted,
        onHeaders(status) {
            job.responseStatus = status
        },
    })
    const liveReader = liveStream.getReader()
    let snapshotConsumed = false
    // With no prefetch, the second pull cannot run until the reader has fully
    // processed the snapshot chunk (including every event line it contains).
    // That gives us an exact one-render snapshot boundary while the same
    // reader retains any incomplete trailing line for the live bytes.
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (snapshot) {
                const bytes = snapshot
                snapshot = undefined
                if (bytes.length > 0) {
                    controller.enqueue(bytes)
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
    serverProviderAuth?: import('../../../network/transportTypes').ServerProviderAuth
    responseDecoder?: import('../../../preset/adapter/types').AdapterResponseDecoder
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

    const jobRes = await fetch('/api/generation/jobs', {
        method: 'POST',
        headers: {
            'Content-Type': BINARY_MESSAGE_CONTENT_TYPE,
            'risu-auth': auth,
            'x-sync-client-id': getRevenantGenerationSyncClientId(),
        },
        body: encodeGenerationRequest({
            url,
            method: arg.method,
            headers: arg.headers,
            serverProviderAuth: arg.serverProviderAuth,
            body: arg.body,
            timeoutMs: arg.requestTimeoutMs,
            heartbeatSec: defaultGenerationHeartbeatSec,
            ...arg.generationRequest.job,
            workflowId: arg.generationRequest.workflow?.workflowId,
            workflowStepKey: arg.generationRequest.workflow?.stepKey,
            workflowStepExecutionId: arg.generationRequest.workflow?.executionId,
            workflowDependency: arg.generationRequest.workflow?.dependency,
            workflowClientAction: arg.generationRequest.workflow?.clientAction,
            responseDecoder: arg.responseDecoder ?? arg.generationRequest.job.responseDecoder,
            ...(arg.generationRequest.job.chatId
                ? getRevenantGenerationMetadata(arg.generationRequest.job.chatId)
                : undefined),
        }),
        signal: arg.signal,
    })

    if (!jobRes.ok) {
        const payload = await readApiErrorPayload(jobRes)
        throw new GenerationJobRegistrationError(
            jobRes.status,
            localizedApiErrorMessage({
                code: payload.code,
                message: payload.message,
                status: jobRes.status,
            }),
            payload.code,
        )
    }

    const { jobId, createdAt, workflowId } = await jobRes.json() as {
        jobId?: unknown
        createdAt?: unknown
        workflowId?: string
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
    trackRevenantGenerationWorkflow(jobId, workflowId ?? arg.generationRequest.workflow?.workflowId)
    if (workflowId) {
        observeRevenantWorkflowRequests(workflowId, arg.signal)
    }
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
        // A caller that attached a decoder reads the server's decoded events.
        arg.responseDecoder ? 'events' : undefined,
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
    format?: 'events',
): Promise<Response> {
    return new Promise((resolve, reject) => {
        let settled = false
        const stream = openRevenantJournalSocket({
            jobId,
            auth,
            signal,
            format,
            onProviderStarted,
            onHeaders(status, headers) {
                if (settled) return
                settled = true
                // Decoded events replace the provider body and its encoding.
                const decoded = format === 'events' && status >= 200 && status < 300
                const bodyHeaders = decoded
                    ? {
                        ...Object.fromEntries(Object.entries(headers)
                            .filter(([key]) => !/^content-(type|length|encoding)$/i.test(key))),
                        'content-type': 'application/x-ndjson',
                    }
                    : headers
                resolve(new Response(stream, {
                    status,
                    headers: {
                        ...bodyHeaders,
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

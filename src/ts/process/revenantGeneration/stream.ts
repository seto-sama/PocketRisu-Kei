import {
    decodeProxyJobWsChunk,
    formatProxyStreamErrorMessage,
    parseProxyJobWsEvent,
} from '../../network/proxyJobWs'
import {
    createRevenantGenerationAuth,
    getRevenantGenerationMetadata,
    getRevenantGenerationSyncClientId,
    setRevenantGenerationLocallyOwned,
    trackRevenantGenerationJob,
} from './client'
import { decodeRevenantGenerationJournal } from './journalDecoder'
import { openRevenantJournalSocket } from './journalSocket'
import type {
    RecoverableAuxiliaryJob,
    RecoverableGenerationJob,
    RevenantGenerationContext,
} from './types'

type RecoverableJournalJob = RecoverableGenerationJob | RecoverableAuxiliaryJob

const defaultProxyJobHeartbeatSec = 15

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

export async function fetchViaProxyJobWs(url: string, arg: {
    method: string
    headers: Record<string, string>
    body?: Uint8Array
    signal?: AbortSignal
    requestTimeoutMs?: number
    revenant?: boolean
    onJobCreated?: (jobId: string) => void
    generationContext?: RevenantGenerationContext
}): Promise<Response> {
    const auth = await createRevenantGenerationAuth()
    const bodyBase64 = arg.body ? Buffer.from(arg.body).toString('base64') : ''

    const jobEndpoint = arg.revenant ? '/api/generation/jobs' : '/proxy-stream-jobs'
    const jobRes = await fetch(jobEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'risu-auth': auth,
            ...(arg.revenant ? { 'x-sync-client-id': getRevenantGenerationSyncClientId() } : {}),
        },
        body: JSON.stringify({
            url,
            method: arg.method,
            headers: arg.headers,
            bodyBase64,
            timeoutMs: arg.requestTimeoutMs,
            heartbeatSec: defaultProxyJobHeartbeatSec,
            ...(arg.generationContext ?? {}),
            ...(arg.generationContext?.chatId
                ? getRevenantGenerationMetadata(arg.generationContext.chatId)
                : undefined),
        }),
        signal: arg.signal,
    })

    if (!jobRes.ok) {
        throw new Error(`Failed to create proxy stream job: ${jobRes.status} ${await jobRes.text()}`)
    }

    const { jobId } = await jobRes.json() as { jobId: string }
    arg.onJobCreated?.(jobId)
    if (arg.revenant) {
        setRevenantGenerationLocallyOwned(jobId, true)
    }
    if (arg.revenant && arg.generationContext?.jobType === 'model' && arg.generationContext.chatId) {
        trackRevenantGenerationJob(arg.generationContext.chatId, jobId)
    }
    return arg.revenant
        ? openRevenantProxyJobResponse(jobId, auth, arg.signal)
        : openLegacyProxyJobResponse(jobId, auth, arg.signal)
}

function deleteProxyJob(
    jobId: string,
    auth: string,
    revenant: boolean,
): Promise<void> {
    return fetch(revenant
        ? `/api/generation/jobs/${encodeURIComponent(jobId)}`
        : `/proxy-stream-jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: {
            'risu-auth': auth,
            ...(revenant ? { 'x-sync-client-id': getRevenantGenerationSyncClientId() } : {}),
        },
    }).then(() => {}, () => {})
}

function openRevenantProxyJobResponse(
    jobId: string,
    auth: string,
    signal?: AbortSignal,
): Promise<Response> {
    return new Promise((resolve, reject) => {
        let settled = false
        const stream = openRevenantJournalSocket({
            jobId,
            auth,
            signal,
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
                setRevenantGenerationLocallyOwned(jobId, false)
                if (settled) return
                settled = true
                reject(error)
            },
            onLocalAbort() {
                setRevenantGenerationLocallyOwned(jobId, false)
                void deleteProxyJob(jobId, auth, true)
            },
        })
    })
}

function openLegacyProxyJobResponse(
    jobId: string,
    auth: string,
    signal?: AbortSignal,
): Promise<Response> {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${location.host}/proxy-stream-jobs/${encodeURIComponent(jobId)}/ws?risu-auth=${encodeURIComponent(auth)}`
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        let settled = false
        let terminal = false
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
        const cleanup = () => signal?.removeEventListener('abort', abort)
        const abort = () => {
            terminal = true
            ws.close()
            void deleteProxyJob(jobId, auth, false)
            const error = new DOMException('Aborted', 'AbortError')
            if (!settled) {
                settled = true
                reject(error)
            }
            else {
                try { streamController?.error(error) } catch { /* already closed */ }
            }
        }
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                streamController = controller
            },
            cancel() {
                terminal = true
                ws.close()
                void deleteProxyJob(jobId, auth, false)
            },
        })
        ws.onmessage = event => {
            const parsed = parseProxyJobWsEvent(typeof event.data === 'string' ? event.data : '')
            if (!parsed) return
            switch (parsed.type) {
                case 'upstream_headers':
                    if (!settled) {
                        settled = true
                        resolve(new Response(stream, {
                            status: parsed.status,
                            headers: parsed.headers,
                        }))
                    }
                    break
                case 'chunk':
                    streamController?.enqueue(decodeProxyJobWsChunk(parsed.dataBase64))
                    break
                case 'error': {
                    terminal = true
                    const message = formatProxyStreamErrorMessage(parsed.status, parsed.message)
                    if (!settled) {
                        settled = true
                        resolve(new Response(message, { status: parsed.status ?? 502 }))
                    }
                    else streamController?.error(new Error(message))
                    cleanup()
                    ws.close()
                    break
                }
                case 'done':
                    terminal = true
                    streamController?.close()
                    cleanup()
                    ws.close()
            }
        }
        ws.onerror = () => ws.close()
        ws.onclose = () => {
            cleanup()
            if (terminal) return
            const error = new Error('WebSocket closed before completion')
            if (!settled) {
                settled = true
                reject(error)
            }
            else {
                try { streamController?.error(error) } catch { /* already closed */ }
            }
        }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
    })
}

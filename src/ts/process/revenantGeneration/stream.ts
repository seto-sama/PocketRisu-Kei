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
import type { RevenantGenerationContext } from './types'

const defaultProxyJobHeartbeatSec = 15

export function subscribeRecoverableGeneration(
    jobId: string,
    handlers: {
        onContent: (content: string) => void
        onDone: () => void
        onError?: (error: unknown) => void
    },
): () => void {
    let disposed = false
    let ws: WebSocket | undefined
    let terminal = false
    const fail = (error: unknown) => {
        if (disposed || terminal) return
        terminal = true
        handlers.onError?.(error)
    }

    void createRevenantGenerationAuth().then(auth => {
        if (disposed) return
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${wsProtocol}//${location.host}/proxy-stream-jobs/${encodeURIComponent(jobId)}/ws?risu-auth=${encodeURIComponent(auth)}&mode=recovery`
        ws = new WebSocket(wsUrl)

        ws.onmessage = event => {
            const parsed = parseProxyJobWsEvent(typeof event.data === 'string' ? event.data : '')
            if (!parsed) return
            if (parsed.type === 'generation_content') {
                handlers.onContent(parsed.content)
            }
            else if (parsed.type === 'done') {
                terminal = true
                handlers.onDone()
                ws?.close()
            }
            else if (parsed.type === 'error') {
                fail(new Error(formatProxyStreamErrorMessage(parsed.status, parsed.message)))
                ws?.close()
            }
        }
        ws.onerror = event => {
            fail(event)
        }
        ws.onclose = () => {
            fail(new Error('Recovery generation WebSocket closed before completion'))
        }
    }).catch(error => {
        fail(error)
    })

    return () => {
        disposed = true
        ws?.close()
    }
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
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${location.host}/proxy-stream-jobs/${encodeURIComponent(jobId)}/ws?risu-auth=${encodeURIComponent(auth)}`

    return new Promise<Response>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        let resolved = false
        let responseStatus = 200
        let responseHeaders: Record<string, string> = {}
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
        let receivedDone = false

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                streamController = controller
            },
            cancel() {
                ws.close()
                if (arg.revenant) setRevenantGenerationLocallyOwned(jobId, false)
                fetch(arg.revenant
                    ? `/api/generation/jobs/${encodeURIComponent(jobId)}`
                    : `/proxy-stream-jobs/${encodeURIComponent(jobId)}`, {
                    method: 'DELETE',
                    headers: {
                        'risu-auth': auth,
                        ...(arg.revenant ? { 'x-sync-client-id': getRevenantGenerationSyncClientId() } : {}),
                    },
                }).catch(() => {})
            },
        })

        const abortHandler = () => {
            ws.close()
            if (arg.revenant) setRevenantGenerationLocallyOwned(jobId, false)
            fetch(arg.revenant
                ? `/api/generation/jobs/${encodeURIComponent(jobId)}`
                : `/proxy-stream-jobs/${encodeURIComponent(jobId)}`, {
                method: 'DELETE',
                headers: {
                    'risu-auth': auth,
                    ...(arg.revenant ? { 'x-sync-client-id': getRevenantGenerationSyncClientId() } : {}),
                },
            }).catch(() => {})
            if (!resolved) {
                resolved = true
                reject(new DOMException('Aborted', 'AbortError'))
            }
        }

        if (arg.signal) {
            if (arg.signal.aborted) {
                abortHandler()
                return
            }
            arg.signal.addEventListener('abort', abortHandler, { once: true })
        }

        ws.onmessage = event => {
            const parsed = parseProxyJobWsEvent(typeof event.data === 'string' ? event.data : '')
            if (!parsed) return

            switch (parsed.type) {
                case 'job_accepted':
                case 'ping':
                    break
                case 'upstream_headers':
                    responseStatus = parsed.status
                    responseHeaders = parsed.headers
                    if (!resolved) {
                        resolved = true
                        resolve(new Response(stream, {
                            status: responseStatus,
                            headers: {
                                ...responseHeaders,
                                ...(arg.revenant ? {
                                    'x-risu-revenant-generation': '1',
                                    'x-risu-generation-job-id': jobId,
                                } : {}),
                            },
                        }))
                    }
                    break
                case 'chunk':
                    streamController?.enqueue(decodeProxyJobWsChunk(parsed.dataBase64))
                    break
                case 'error': {
                    receivedDone = true
                    const message = formatProxyStreamErrorMessage(parsed.status, parsed.message)
                    if (!resolved) {
                        resolved = true
                        resolve(new Response(message, {
                            status: parsed.status ?? 502,
                            headers: { 'content-type': 'text/plain' },
                        }))
                    }
                    streamController?.close()
                    ws.close()
                    break
                }
                case 'done':
                    receivedDone = true
                    streamController?.close()
                    ws.close()
                    break
            }
        }

        ws.onerror = () => {
            if (!resolved) {
                resolved = true
                reject(new Error('WebSocket connection failed'))
            }
        }

        ws.onclose = () => {
            arg.signal?.removeEventListener('abort', abortHandler)
            const explicitlyAborted = arg.signal?.aborted === true
            if (arg.revenant && !receivedDone && !explicitlyAborted) {
                setRevenantGenerationLocallyOwned(jobId, false)
            }
            try {
                if (explicitlyAborted) {
                    streamController?.error(new DOMException('Request aborted', 'AbortError'))
                }
                else if (arg.revenant && !receivedDone) {
                    streamController?.error(new Error('Generation stream detached; server job continues'))
                }
                else {
                    streamController?.close()
                }
            }
            catch {
                // The response stream may already be closed.
            }
            if (!resolved) {
                resolved = true
                reject(new Error('WebSocket closed before response'))
            }
        }
    })
}

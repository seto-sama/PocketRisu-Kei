import {
    decodeProxyJobWsChunk,
    formatProxyStreamErrorMessage,
    parseProxyJobWsEvent,
    trimProxyJobWsReplay,
    type ProxyJobWsDoneEvent,
} from '../../../network/proxyJobWs'

export interface RevenantJournalSocketOptions {
    jobId: string
    auth: string
    signal?: AbortSignal
    recovery?: boolean
    onProviderStarted?: (startedAt: number) => void
    onHeaders?: (status: number, headers: Record<string, string>) => void
    onDone?: (terminal: ProxyJobWsDoneEvent) => void
    onFatal?: (error: Error) => void
    signalAction?: 'detach' | 'cancel_job'
    onDetached?: () => void
    onCancelRequested?: () => void
    reconnectBaseMs?: number
    maxReconnectAttempts?: number
}

/**
 * Opens one logical provider-byte stream over any number of WebSocket
 * connections. Every reconnect requests the journal at the next byte offset;
 * replay overlap is trimmed before consumers see it.
 */
export function openRevenantJournalSocket(
    options: RevenantJournalSocketOptions,
): ReadableStream<Uint8Array> {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsBaseUrl = `${wsProtocol}//${location.host}/api/generation/jobs/${encodeURIComponent(options.jobId)}/journal/ws?risu-auth=${encodeURIComponent(options.auth)}`
    const maxReconnectAttempts = options.maxReconnectAttempts ?? 5
    const reconnectBaseMs = options.reconnectBaseMs ?? 1000
    let detachLocal = () => options.onDetached?.()

    return new ReadableStream<Uint8Array>({
        start(controller) {
            let ws: WebSocket | undefined
            let receivedBytes = 0
            let disposed = false
            let terminal = false
            let reconnectAttempts = 0
            let providerStartedReported = false
            let upstreamStatus: number | undefined
            let reconnectTimer: ReturnType<typeof setTimeout> | undefined

            const closeSocket = () => {
                if (reconnectTimer) clearTimeout(reconnectTimer)
                options.signal?.removeEventListener('abort', abortLocal)
                ws?.close()
                ws = undefined
            }
            const fail = (error: Error) => {
                if (disposed) return
                disposed = true
                closeSocket()
                options.onFatal?.(error)
                try { controller.error(error) } catch { /* already closed */ }
            }
            const finish = (terminalEvent: ProxyJobWsDoneEvent = { type: 'done' }) => {
                if (disposed) return
                disposed = true
                terminal = true
                closeSocket()
                options.onDone?.(terminalEvent)
                try { controller.close() } catch { /* already closed */ }
            }
            const abortLocal = () => {
                if (disposed) return
                if (options.signalAction === 'cancel_job') options.onCancelRequested?.()
                options.onDetached?.()
                fail(new DOMException('Journal stream aborted', 'AbortError'))
            }
            detachLocal = () => {
                if (disposed) return
                disposed = true
                closeSocket()
                options.onDetached?.()
            }
            const scheduleReconnect = () => {
                if (disposed || terminal || options.signal?.aborted) return
                if (reconnectAttempts >= maxReconnectAttempts) {
                    fail(new Error('Generation journal WebSocket reconnect limit exceeded'))
                    return
                }
                const delay = Math.min(reconnectBaseMs * 2 ** reconnectAttempts, 15_000)
                reconnectAttempts += 1
                reconnectTimer = setTimeout(connect, delay)
            }
            const connect = () => {
                if (disposed || terminal || options.signal?.aborted) return
                const recovery = options.recovery ? '&recovery=1' : ''
                const socket = new WebSocket(
                    `${wsBaseUrl}${recovery}&offset=${receivedBytes}`,
                )
                ws = socket
                socket.onmessage = event => {
                    const parsed = parseProxyJobWsEvent(
                        typeof event.data === 'string' ? event.data : '',
                    )
                    if (!parsed) return
                    switch (parsed.type) {
                        case 'job_accepted':
                        case 'ping':
                            return
                        case 'provider_started':
                            if (!providerStartedReported) {
                                providerStartedReported = true
                                options.onProviderStarted?.(parsed.startedAt)
                            }
                            return
                        case 'upstream_headers':
                            upstreamStatus = parsed.status
                            options.onHeaders?.(parsed.status, parsed.headers)
                            return
                        case 'chunk': {
                            let chunk = decodeProxyJobWsChunk(parsed.dataBase64)
                            try {
                                const trimmed = trimProxyJobWsReplay(
                                    chunk,
                                    parsed.offset,
                                    receivedBytes,
                                )
                                if (!trimmed) return
                                chunk = trimmed
                            }
                            catch {
                                socket.close()
                                return
                            }
                            receivedBytes += chunk.length
                            reconnectAttempts = 0
                            controller.enqueue(chunk)
                            return
                        }
                        case 'done':
                            finish(parsed)
                            return
                        case 'error':
                            // Older Revenant servers terminate every non-2xx
                            // provider response as a socket error after sending
                            // its complete body. Preserve that body as a normal
                            // Response so the provider adapter can extract the
                            // actual error message and classify retryability.
                            if (parsed.status === 502
                                && upstreamStatus !== undefined
                                && (upstreamStatus < 200 || upstreamStatus >= 300)) {
                                finish()
                                return
                            }
                            fail(new Error(formatProxyStreamErrorMessage(
                                parsed.status,
                                parsed.message,
                            )))
                    }
                }
                socket.onerror = () => {
                    try { socket.close() } catch { /* close handler reconnects */ }
                }
                socket.onclose = () => {
                    if (ws === socket) ws = undefined
                    if (!disposed && !terminal && !options.signal?.aborted) {
                        scheduleReconnect()
                    }
                }
            }

            if (options.signal?.aborted) {
                abortLocal()
                return
            }
            options.signal?.addEventListener('abort', abortLocal, { once: true })
            connect()
        },
        cancel() {
            detachLocal()
        },
    })
}

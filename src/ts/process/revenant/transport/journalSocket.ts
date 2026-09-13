import {
    decodeJournalChunk,
    parseRevenantControlEvent,
    trimJournalReplay,
    type RevenantDoneEvent,
} from './protocol'

const JOURNAL_QUEUE_BYTES = 256 * 1024

export interface RevenantJournalSocketOptions {
    jobId: string
    auth: string
    signal?: AbortSignal
    recovery?: boolean
    initialOffset?: number
    onProviderStarted?: (startedAt: number) => void
    onHeaders?: (status: number, headers: Record<string, string>) => void
    onDone?: (terminal: RevenantDoneEvent) => void
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
    let resumeLocal = () => {}

    return new ReadableStream<Uint8Array>({
        start(controller) {
            let ws: WebSocket | undefined
            let receivedBytes = Number.isSafeInteger(options.initialOffset)
                && (options.initialOffset ?? 0) >= 0
                ? options.initialOffset ?? 0
                : 0
            let disposed = false
            let paused = false
            let reconnectAttempts = 0
            let providerStartedReported = false
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
            const finish = (terminalEvent: RevenantDoneEvent) => {
                if (disposed) return
                disposed = true
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
                if (disposed || options.signal?.aborted) return
                if (reconnectAttempts >= maxReconnectAttempts) {
                    fail(new Error('Generation journal WebSocket reconnect limit exceeded'))
                    return
                }
                const delay = Math.min(reconnectBaseMs * 2 ** reconnectAttempts, 15_000)
                reconnectAttempts += 1
                reconnectTimer = setTimeout(connect, delay)
            }
            const connect = () => {
                if (disposed || options.signal?.aborted) return
                const recovery = options.recovery ? '&recovery=1' : ''
                const socket = new WebSocket(
                    `${wsBaseUrl}${recovery}&offset=${receivedBytes}`,
                )
                ws = socket
                socket.binaryType = 'arraybuffer'
                socket.onmessage = event => {
                    if (disposed || ws !== socket) return
                    if (event.data instanceof ArrayBuffer) {
                        try {
                            const { bytes, offset } = decodeJournalChunk(new Uint8Array(event.data))
                            const chunk = trimJournalReplay(bytes, offset, receivedBytes)
                            if (!chunk) return
                            receivedBytes += chunk.length
                            reconnectAttempts = 0
                            controller.enqueue(chunk)
                            if ((controller.desiredSize ?? 0) <= 0) {
                                // WS cannot pause incoming bytes. Detach at the accepted
                                // offset and replay the tail when the decoder needs more.
                                paused = true
                                ws = undefined
                                socket.close()
                            }
                        } catch {
                            // Resume from the last valid byte after a malformed frame or gap.
                            socket.close()
                        }
                        return
                    }
                    const parsed = parseRevenantControlEvent(event.data)
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
                            options.onHeaders?.(parsed.status, parsed.headers)
                            return
                        case 'done':
                            finish(parsed)
                            return
                        case 'error':
                            fail(new Error(parsed.message || `Generation stream failed (${parsed.status ?? 'unknown'})`))
                    }
                }
                socket.onerror = () => {
                    try { socket.close() } catch { /* close handler reconnects */ }
                }
                socket.onclose = () => {
                    if (ws !== socket) return
                    ws = undefined
                    if (!disposed && !options.signal?.aborted) {
                        scheduleReconnect()
                    }
                }
            }
            resumeLocal = () => {
                if (paused && !disposed && (controller.desiredSize ?? 0) > 0) {
                    paused = false
                    connect()
                }
            }

            if (options.signal?.aborted) {
                abortLocal()
                return
            }
            options.signal?.addEventListener('abort', abortLocal, { once: true })
            connect()
        },
        pull() {
            resumeLocal()
        },
        cancel() {
            detachLocal()
        },
    }, { highWaterMark: JOURNAL_QUEUE_BYTES, size: chunk => chunk.byteLength })
}

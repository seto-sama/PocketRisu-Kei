import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openRevenantJournalSocket } from './journalSocket'

class FakeWebSocket {
    static instances: FakeWebSocket[] = []
    readonly url: string
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    closed = false

    constructor(url: string) {
        this.url = url
        FakeWebSocket.instances.push(this)
    }

    emit(event: object): void {
        this.onmessage?.({ data: JSON.stringify(event) })
    }

    close(): void {
        if (this.closed) return
        this.closed = true
        this.onclose?.()
    }
}

describe('openRevenantJournalSocket', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        FakeWebSocket.instances = []
        vi.stubGlobal('WebSocket', FakeWebSocket)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('reconnects at the received offset and removes replay overlap', async () => {
        const stream = openRevenantJournalSocket({
            jobId: 'job-1',
            auth: 'auth',
            reconnectBaseMs: 1,
        })
        const reader = stream.getReader()
        const first = FakeWebSocket.instances[0]
        expect(first.url).toContain('/api/generation/jobs/job-1/journal/ws')
        first.emit({
            type: 'chunk',
            offset: 0,
            dataBase64: Buffer.from('abc').toString('base64'),
        })
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('abc')

        first.close()
        await vi.advanceTimersByTimeAsync(1)
        const second = FakeWebSocket.instances[1]
        expect(second.url).toContain('offset=3')

        second.emit({
            type: 'chunk',
            offset: 1,
            dataBase64: Buffer.from('bcde').toString('base64'),
        })
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('de')

        second.emit({ type: 'done' })
        expect((await reader.read()).done).toBe(true)
    })

    it('uses recovery terminal semantics only when requested', () => {
        openRevenantJournalSocket({ jobId: 'job-2', auth: 'auth', recovery: true })
        expect(FakeWebSocket.instances[0].url).toContain('recovery=1&offset=0')
    })

    it('detaches a cancelled reader without cancelling the server job', async () => {
        const onDetached = vi.fn()
        const onCancelRequested = vi.fn()
        const stream = openRevenantJournalSocket({
            jobId: 'job-detach',
            auth: 'auth',
            signalAction: 'cancel_job',
            onDetached,
            onCancelRequested,
        })

        await stream.getReader().cancel()

        expect(onDetached).toHaveBeenCalledOnce()
        expect(onCancelRequested).not.toHaveBeenCalled()
        expect(FakeWebSocket.instances[0].closed).toBe(true)
    })

    it('turns an explicit cancellation signal into a job cancellation request', async () => {
        const abortController = new AbortController()
        const onDetached = vi.fn()
        const onCancelRequested = vi.fn()
        const stream = openRevenantJournalSocket({
            jobId: 'job-cancel',
            auth: 'auth',
            signal: abortController.signal,
            signalAction: 'cancel_job',
            onDetached,
            onCancelRequested,
        })
        const reader = stream.getReader()
        abortController.abort()

        await expect(reader.closed).rejects.toMatchObject({ name: 'AbortError' })
        expect(onDetached).toHaveBeenCalledOnce()
        expect(onCancelRequested).toHaveBeenCalledOnce()
    })

    it('reports terminal completion even when no provider headers arrived', async () => {
        const onDone = vi.fn()
        const stream = openRevenantJournalSocket({
            jobId: 'job-cancelled',
            auth: 'auth',
            onDone,
        })
        const reader = stream.getReader()

        FakeWebSocket.instances[0].emit({
            type: 'done',
            status: 'cancelled',
            partial: true,
            finishReason: 'workflow_cancelled',
        })

        expect((await reader.read()).done).toBe(true)
        expect(onDone).toHaveBeenCalledOnce()
        expect(onDone).toHaveBeenCalledWith({
            type: 'done',
            status: 'cancelled',
            partial: true,
            finishReason: 'workflow_cancelled',
        })
    })

    it('preserves a provider error body from older servers for adapter parsing', async () => {
        const onFatal = vi.fn()
        let responseStatus = 0
        const stream = openRevenantJournalSocket({
            jobId: 'job-provider-error',
            auth: 'auth',
            onHeaders(status) {
                responseStatus = status
            },
            onFatal,
        })
        const bodyPromise = new Response(stream).text()
        const socket = FakeWebSocket.instances[0]
        const body = JSON.stringify({
            error: {
                code: 400,
                message: 'Requests ending with a model turn are not supported.',
                status: 'INVALID_ARGUMENT',
            },
        })

        socket.emit({ type: 'upstream_headers', status: 400, headers: {} })
        socket.emit({
            type: 'chunk',
            offset: 0,
            dataBase64: Buffer.from(body).toString('base64'),
        })
        socket.emit({ type: 'error', status: 502, message: 'Provider request failed with HTTP 400' })

        expect(responseStatus).toBe(400)
        expect(await bodyPromise).toBe(body)
        expect(onFatal).not.toHaveBeenCalled()
    })

    it('still rejects a transport failure after non-2xx provider headers', async () => {
        const onFatal = vi.fn()
        const stream = openRevenantJournalSocket({
            jobId: 'job-truncated-provider-error',
            auth: 'auth',
            onFatal,
        })
        const bodyPromise = new Response(stream).text()
        const socket = FakeWebSocket.instances[0]

        socket.emit({ type: 'upstream_headers', status: 400, headers: {} })
        socket.emit({ type: 'error', status: 504, message: 'provider body interrupted' })

        await expect(bodyPromise).rejects.toThrow('Cloudflare/origin timeout')
        expect(onFatal).toHaveBeenCalledOnce()
    })
})

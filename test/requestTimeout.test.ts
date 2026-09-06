import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWithRequestTimeout, DEFAULT_REQUEST_TIMEOUT_MS, requestIdleTimeoutMs } from '../shared/requestTimeout.mjs'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const pending = () => new Promise<Response>(() => {})

describe('shared request timeout lifecycle', () => {
    it('bounds even a request that ignores abort', async () => {
        let signal: AbortSignal
        const request = fetchWithRequestTimeout(async value => { signal = value; return pending() }, { firstResponseTimeoutMs: 30 })
        const failed = expect(request).rejects.toMatchObject({ name: 'TimeoutError' })
        await vi.advanceTimersByTimeAsync(30)
        await failed
        expect(signal!.aborted).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels a late response after its header timeout', async () => {
        let resolve: (response: Response) => void
        const cancel = vi.fn()
        const request = fetchWithRequestTimeout(() => new Promise(done => { resolve = done }), { firstResponseTimeoutMs: 30 })
        const failed = expect(request).rejects.toMatchObject({ name: 'TimeoutError' })
        await vi.advanceTimersByTimeAsync(30)
        await failed
        resolve!(new Response(new ReadableStream({ cancel })))
        await vi.advanceTimersByTimeAsync(0)
        expect(cancel).toHaveBeenCalledOnce()
    })

    it('does not limit body downloads when only headers have a deadline', async () => {
        let output: ReadableStreamDefaultController<Uint8Array>
        const response = await fetchWithRequestTimeout(async () => new Response(new ReadableStream({ start(c) { output = c } })), { firstResponseTimeoutMs: 30 })
        const text = response.text()
        await vi.advanceTimersByTimeAsync(1000)
        output!.enqueue(new TextEncoder().encode('large chat'))
        output!.close()
        expect(await text).toBe('large chat')
        expect(vi.getTimerCount()).toBe(0)
    })

    it('limits idle reads without imposing a total duration or counting backpressure', async () => {
        let output: ReadableStreamDefaultController<Uint8Array>
        const response = await fetchWithRequestTimeout(async () => new Response(new ReadableStream({ start(c) { output = c } })), { idleTimeoutMs: 100 })
        const reader = response.body!.getReader()
        for (let i = 0; i < 3; i++) {
            const read = reader.read()
            await vi.advanceTimersByTimeAsync(90)
            output!.enqueue(new Uint8Array([i]))
            expect((await read).value).toEqual(new Uint8Array([i]))
            await vi.advanceTimersByTimeAsync(500) // consumer processing, not an upstream stall
        }
        const read = reader.read()
        const failed = expect(read).rejects.toMatchObject({ name: 'TimeoutError' })
        await vi.advanceTimersByTimeAsync(100)
        await failed
        expect(vi.getTimerCount()).toBe(0)
    })

    it('preserves caller cancellation before headers and during a stalled body', async () => {
        const before = new AbortController()
        const headers = fetchWithRequestTimeout(pending, { signal: before.signal, firstResponseTimeoutMs: 30 })
        const failedHeaders = expect(headers).rejects.toThrow('cancelled')
        before.abort(new Error('cancelled'))
        await failedHeaders
        const controller = new AbortController()
        const cancel = vi.fn()
        const response = await fetchWithRequestTimeout(async () => new Response(new ReadableStream({ cancel })), { signal: controller.signal, idleTimeoutMs: 100 })
        const failedBody = expect(response.text()).rejects.toThrow('cancelled')
        controller.abort(new Error('cancelled'))
        await failedBody
        expect(cancel).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps caller abort linked to the original fetch after headers', async () => {
        const controller = new AbortController()
        let upstreamSignal: AbortSignal
        await fetchWithRequestTimeout(async signal => {
            upstreamSignal = signal
            return new Response('body')
        }, { signal: controller.signal, firstResponseTimeoutMs: 30 })
        controller.abort()
        expect(upstreamSignal!.aborted).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels the upstream when the consumer cancels, and cleans up normal completion', async () => {
        let signal: AbortSignal
        const cancel = vi.fn()
        const response = await fetchWithRequestTimeout(async s => { signal = s; return new Response(new ReadableStream({ cancel })) }, { idleTimeoutMs: 100 })
        await response.body!.cancel()
        expect(signal!.aborted).toBe(true)
        expect(cancel).toHaveBeenCalledOnce()
        const complete = await fetchWithRequestTimeout(async () => new Response('ok'), { idleTimeoutMs: 100 })
        expect(await complete.text()).toBe('ok')
        expect(vi.getTimerCount()).toBe(0)
    })

    it('uses the existing default while respecting longer request timeouts', () => {
        expect(requestIdleTimeoutMs(undefined)).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
        expect(requestIdleTimeoutMs(100)).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
        expect(requestIdleTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS * 2)).toBe(DEFAULT_REQUEST_TIMEOUT_MS * 2)
    })
})

it('preserves direct response metadata while observing its stream', async () => {
    const upstream = new Response('body', { status: 201, statusText: 'Created', headers: { 'x-test': 'kept' } })
    Object.defineProperties(upstream, {
        url: { value: 'https://provider.example/final' },
        redirected: { value: true },
        type: { value: 'cors' },
    })
    const response = await fetchWithRequestTimeout(async () => upstream, { idleTimeoutMs: 100 })
    expect(response.url).toBe(upstream.url)
    expect(response.redirected).toBe(true)
    expect(response.type).toBe('cors')
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.headers.get('x-test')).toBe('kept')
    expect(await response.text()).toBe('body')
})

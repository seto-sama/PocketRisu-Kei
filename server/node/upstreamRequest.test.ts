import { describe, expect, test, vi } from 'vitest'

const {
    executeEchoProviderRequest,
    executeUpstreamRequest,
    filterUpstreamResponseHeaders,
    filterUpstreamRequestHeaders,
} = require('./upstreamRequest.cjs')

async function readRemainingText(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
        const { value, done } = await reader.read()
        if (done) return text + decoder.decode()
        text += decoder.decode(value, { stream: true })
    }
}

describe('filterUpstreamResponseHeaders', () => {
    test('drops hop-by-hop, stale length, encoding, and browser policy headers', () => {
        const filtered = filterUpstreamResponseHeaders(new Headers({
            'Content-Type': 'text/event-stream',
            'Content-Encoding': 'gzip',
            'Content-Length': '123',
            'Transfer-Encoding': 'chunked',
            'Content-Security-Policy': "default-src 'none'",
            'Cache-Control': 'private',
            'X-Upstream': 'kept',
            'Set-Cookie': 'session=upstream; Path=/',
        }))

        expect(filtered).toEqual({
            'content-type': 'text/event-stream',
            'x-upstream': 'kept',
        })
    })
})

test('keeps provider authorization while stripping local credentials and transport headers case-insensitively', () => {
    expect(filterUpstreamRequestHeaders({
        Authorization: 'Bearer model-key', 'X-Api-Key': 'provider-key',
        'Risu-Auth': 'kei-token', Cookie: 'session=kei', Host: 'kei.local',
        Connection: 'x-hop', 'X-Hop': 'private', 'Content-Length': '999',
        'X-Forwarded-For': '127.0.0.1',
    })).toEqual({ authorization: 'Bearer model-key', 'x-api-key': 'provider-key' })
})

describe('executeEchoProviderRequest', () => {
    test.each([false, true])('waits for the configured delay before the first response chunk (stream=%s)', async stream => {
        vi.useFakeTimers()
        try {
            const response = await executeEchoProviderRequest({
                body: Buffer.from(JSON.stringify({
                    message: 'durable echo', delayMs: 500, model: 'Echo', stream,
                })),
                signal: new AbortController().signal,
            })
            expect(response.status).toBe(200)
            const reader = response.body.getReader()
            const received = vi.fn()
            const first = reader.read().then((chunk: ReadableStreamReadResult<Uint8Array>) => {
                received()
                return new TextDecoder().decode(chunk.value)
            })
            await vi.advanceTimersByTimeAsync(499)
            expect(received).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(1)
            const chunk = await first
            expect(received).toHaveBeenCalledOnce()
            const remaining = readRemainingText(reader)
            await vi.runAllTimersAsync()
            const tail = await remaining
            if (stream) {
                expect(chunk).toContain('data: ')
                expect(tail).toContain('[DONE]')
            } else {
                const body = JSON.parse(chunk + tail)
                expect(body.choices[0].message.content).toBe('durable echo')
                expect(body.model).toBe('Echo')
            }
        } finally { vi.useRealTimers() }
    })

    test('spaces streaming tokens at the configured TPS', async () => {
        vi.useFakeTimers()
        try {
            const response = await executeEchoProviderRequest({
                body: Buffer.from(JSON.stringify({ message: 'A B C', stream: true, tokensPerSecond: 5 })),
            })
            expect(response.headers['content-type']).toBe('text/event-stream')
            const reader = response.body.getReader()
            const first = await reader.read()
            expect(new TextDecoder().decode(first.value)).toContain('"content"')
            const received = vi.fn()
            const next = reader.read().then((chunk: ReadableStreamReadResult<Uint8Array>) => {
                received()
                return chunk
            })
            await vi.advanceTimersByTimeAsync(199)
            expect(received).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(1)
            expect(new TextDecoder().decode((await next).value)).toContain('"content"')
            const remaining = readRemainingText(reader)
            await vi.runAllTimersAsync()
            expect(await remaining).toContain('[DONE]')
        } finally { vi.useRealTimers() }
    })

    test('aborts while waiting for the configured delay', async () => {
        const controller = new AbortController()
        const response = await executeEchoProviderRequest({
            body: Buffer.from(JSON.stringify({ delayMs: 60_000 })),
            signal: controller.signal,
        })
        controller.abort(new Error('cancelled'))

        await expect(new Response(response.body).text()).rejects.toThrow('cancelled')
    })
})

test('the existing upstream executor surfaces idle body failures and retains response metadata', async () => {
    vi.useFakeTimers()
    try {
        let signal: AbortSignal
        const release = vi.fn()
        const response = await executeUpstreamRequest({
            url: 'https://provider.example', method: 'GET', idleTimeoutMs: 100,
            outboundPolicy: { prepare: async (url: string) => ({ url, dispatcher: {}, release }) },
        },
            async (_url: string, init: RequestInit) => {
                signal = init.signal!
                expect(init.redirect).toBe('error')
                return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream', 'content-length': '99' } })
            })
        expect(response.headers).toEqual({ 'content-type': 'text/event-stream' })
        expect(response.status).toBe(200)
        const failed = expect(new Response(response.body).text()).rejects.toMatchObject({ name: 'TimeoutError' })
        await vi.advanceTimersByTimeAsync(100)
        await failed
        expect(signal!.aborted).toBe(true)
        expect(release).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
})

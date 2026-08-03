import { describe, expect, test, vi } from 'vitest'

const {
    executeUpstreamRequest,
    filterUpstreamResponseHeaders,
} = require('./upstreamRequest.cjs')

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
        }))

        expect(filtered).toEqual({
            'content-type': 'text/event-stream',
            'x-upstream': 'kept',
        })
    })
})

describe('executeUpstreamRequest', () => {
    test('forwards one request shape for synchronous proxy and durable jobs', async () => {
        const body = new ReadableStream<Uint8Array>()
        const fetchImpl = vi.fn().mockResolvedValue({
            status: 201,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body,
        })
        const signal = new AbortController().signal

        const result = await executeUpstreamRequest({
            url: 'https://provider.example/v1/chat',
            method: 'POST',
            headers: { Authorization: 'Bearer key' },
            body: Buffer.from('{}'),
            signal,
        }, fetchImpl)

        expect(fetchImpl).toHaveBeenCalledWith('https://provider.example/v1/chat', {
            method: 'POST',
            headers: { Authorization: 'Bearer key' },
            body: Buffer.from('{}'),
            signal,
            redirect: 'follow',
        })
        expect(result).toEqual({
            status: 201,
            headers: { 'content-type': 'application/json' },
            body,
        })
    })
})

import { describe, expect, test } from 'vitest'

const {
    executeEchoProviderRequest,
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

describe('executeEchoProviderRequest', () => {
    test('returns an OpenAI-compatible response without an upstream call', async () => {
        const response = await executeEchoProviderRequest({
            body: Buffer.from(JSON.stringify({
                message: 'durable echo',
                delayMs: 0,
                model: 'Echo',
            })),
            signal: new AbortController().signal,
        })

        expect(response.status).toBe(200)
        const body = await new Response(response.body).json() as any
        expect(body.choices[0].message.content).toBe('durable echo')
        expect(body.model).toBe('Echo')
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

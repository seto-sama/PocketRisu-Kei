import { describe, expect, test } from 'vitest'
import {
    openPreparedEventStream,
    sendPreparedJsonRequest,
} from './httpTransport'
import type { AdapterPreparedRequest } from './types'

const prepared: AdapterPreparedRequest = {
    method: 'POST',
    url: 'https://provider.test/v1/chat',
    headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer key',
    },
    body: { model: 'demo', stream: false },
}

describe('adapter HTTP transport', () => {
    test('sends a prepared JSON request and parses its response', async () => {
        const controller = new AbortController()
        let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
        const fetchImpl: typeof fetch = async (input, init) => {
            captured = { input, init }
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }

        await expect(sendPreparedJsonRequest(
            prepared,
            { fetchImpl, abortSignal: controller.signal },
            'invalid JSON',
        )).resolves.toEqual({ ok: true })
        expect(captured?.input).toBe(prepared.url)
        expect(captured?.init).toMatchObject({
            method: 'POST',
            headers: prepared.headers,
            body: JSON.stringify(prepared.body),
            signal: controller.signal,
        })
    })

    test('normalizes provider HTTP errors before parsing JSON', async () => {
        const fetchImpl: typeof fetch = async () => new Response(
            JSON.stringify({ error: { message: 'slow down' } }),
            { status: 429 },
        )

        await expect(sendPreparedJsonRequest(
            prepared,
            { fetchImpl },
            'invalid JSON',
        )).rejects.toMatchObject({
            kind: 'rate-limit',
            status: 429,
            message: 'slow down',
        })
    })

    test('wraps response JSON parse failures with the adapter label', async () => {
        const fetchImpl: typeof fetch = async () => new Response('not-json', { status: 200 })

        await expect(sendPreparedJsonRequest(
            prepared,
            { fetchImpl },
            'Provider response is not valid JSON',
        )).rejects.toMatchObject({
            kind: 'parse',
            message: 'Provider response is not valid JSON',
        })
    })

    test('opens an SSE response with the expected Accept header', async () => {
        let headers: Record<string, string> | undefined
        const stream = new ReadableStream<Uint8Array>()
        const fetchImpl: typeof fetch = async (_input, init) => {
            headers = init?.headers as Record<string, string>
            return new Response(stream, { status: 200 })
        }

        await expect(openPreparedEventStream(
            prepared,
            { fetchImpl },
            'stream has no body',
        )).resolves.toBe(stream)
        expect(headers).toEqual({
            ...prepared.headers,
            Accept: 'text/event-stream',
        })
        expect(prepared.headers.Accept).toBeUndefined()
    })

    test('rejects a successful SSE response without a body', async () => {
        const fetchImpl: typeof fetch = async () => new Response(null, { status: 200 })

        await expect(openPreparedEventStream(
            prepared,
            { fetchImpl },
            'Provider stream has no body',
        )).rejects.toMatchObject({
            kind: 'parse',
            message: 'Provider stream has no body',
        })
    })
})

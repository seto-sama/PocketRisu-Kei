import { describe, expect, test } from 'vitest'
import {
    openPreparedChatStream,
    sendPreparedChatRequest,
} from './httpTransport'
import type { AdapterPreparedRequest, AdapterResponseDecoder } from './types'

const prepared: AdapterPreparedRequest = {
    method: 'POST',
    url: 'https://provider.test/v1/chat',
    headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer key',
    },
    body: { model: 'demo', stream: false },
}
const decoder: AdapterResponseDecoder = { adapterKind: 'openai-compatible', stream: false }
const decodeText = (body: string) => ({ text: body, raw: body })

describe('adapter HTTP transport', () => {
    test('sends a prepared request with its decoder and decodes the response body', async () => {
        const controller = new AbortController()
        let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
        const fetchImpl: typeof fetch = async (input, init) => {
            captured = { input, init }
            return new Response('reply', { status: 200 })
        }

        await expect(sendPreparedChatRequest(
            prepared,
            { fetchImpl, abortSignal: controller.signal },
            decoder,
            decodeText,
        )).resolves.toEqual({ text: 'reply', raw: 'reply' })
        expect(captured?.input).toBe(prepared.url)
        expect(captured?.init).toMatchObject({
            method: 'POST',
            headers: prepared.headers,
            body: JSON.stringify(prepared.body),
            signal: controller.signal,
            responseDecoder: decoder,
        })
    })

    test('normalizes provider HTTP errors before parsing JSON', async () => {
        const fetchImpl: typeof fetch = async () => new Response(
            JSON.stringify({ error: { message: 'slow down' } }),
            { status: 429, headers: { 'Retry-After': '3' } },
        )

        await expect(sendPreparedChatRequest(
            prepared,
            { fetchImpl },
            decoder,
            decodeText,
        )).rejects.toMatchObject({
            kind: 'rate-limit',
            status: 429,
            message: 'slow down',
            retryAfterMs: 3_000,
        })
    })

    test('retries an explicit OpenAI-compatible rate-limit code', async () => {
        const fetchImpl: typeof fetch = async () => new Response(
            JSON.stringify({
                error: {
                    message: 'Request rejected.',
                    code: 'rate_limit_exceeded',
                },
            }),
            { status: 429 },
        )

        await expect(sendPreparedChatRequest(
            prepared,
            { fetchImpl },
            decoder,
            decodeText,
        )).rejects.toMatchObject({
            kind: 'rate-limit',
            status: 429,
            retryable: true,
            fallbackEligible: false,
        })
    })

    test('opens an SSE response with the expected Accept header', async () => {
        let headers: Record<string, string> | undefined
        const stream = new ReadableStream<Uint8Array>()
        const fetchImpl: typeof fetch = async (_input, init) => {
            headers = init?.headers as Record<string, string>
            return new Response(stream, { status: 200 })
        }

        await expect(openPreparedChatStream(
            prepared,
            { fetchImpl },
            { ...decoder, stream: true },
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

        await expect(openPreparedChatStream(
            prepared,
            { fetchImpl },
            { ...decoder, stream: true },
            'Provider stream has no body',
        )).rejects.toMatchObject({
            kind: 'parse',
            message: 'Provider stream has no body',
        })
    })
})

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../../shared/requestTimeout.mjs'
import { PROXY_PATH } from '../../../shared/proxy.mjs'

const mocks = vi.hoisted(() => ({ generation: vi.fn(), auth: vi.fn() }))
vi.mock('../process/revenant/transport', () => ({ fetchViaGenerationJob: mocks.generation }))
vi.mock('../stores.svelte', () => ({ DBState: { db: {} }, bodyIntercepterStore: [] }))
vi.mock('../storage/autoStorage', () => ({ forageStorage: { createAuth: mocks.auth } }))
import { fetchNative } from './nativeFetch'
import { DBState } from '../stores.svelte'
import { WORKFLOW_LLM_EXECUTION } from './transportTypes'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    mocks.auth.mockResolvedValue('token')
    DBState.db.hidePublicStats = false
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('follows the current statistics preference when request headers are reused', async () => {
    fetchMock.mockImplementation(async () => new Response('{}'))
    const headers = { Authorization: 'Bearer secret' }

    for (const hidden of [false, true]) {
        DBState.db.hidePublicStats = hidden
        await fetchNative('https://openrouter.ai/api/v1/chat/completions', { body: '{}', headers })

        const sent = new Headers(fetchMock.mock.lastCall![1].headers)
        expect(sent.get('X-Title')).toBe(hidden ? null : 'PocketRisu')
        expect(sent.get('HTTP-Referer')).toBe(hidden ? null : 'https://github.com/PocketRisu/PocketRisu')
        expect(sent.get('Authorization')).toBe('Bearer secret')
    }
})

it('omits PocketRisu identification from requests to other services', async () => {
    fetchMock.mockResolvedValue(new Response('{}'))

    await fetchNative('https://openrouter.ai.example/api/v1/chat/completions', { body: '{}' })

    const sent = new Headers(fetchMock.mock.calls[0][1].headers)
    expect(sent.get('X-Title')).toBeNull()
    expect(sent.get('HTTP-Referer')).toBeNull()
})

it.each([false, true])('respects the statistics preference in server proxy headers: hidden=%s', async (hidden) => {
    DBState.db.hidePublicStats = hidden
    fetchMock.mockResolvedValue(new Response('{}'))

    await fetchNative('https://openrouter.ai/api/v1/chat/completions', {
        body: '{}',
        llmExecutionPolicy: { kind: 'ephemeral', durability: 'off', providerRoute: 'server' },
    })

    expect(fetchMock.mock.calls[0][0]).toBe(PROXY_PATH)
    const headers = new Headers(JSON.parse(decodeURIComponent(fetchMock.mock.calls[0][1].headers['risu-header'])))
    expect(headers.get('X-Title')).toBe(hidden ? null : 'PocketRisu')
    expect(headers.get('HTTP-Referer')).toBe(hidden ? null : 'https://github.com/PocketRisu/PocketRisu')
})

it.each([
    { body: 'grant_type=jwt-bearer&assertion=test', contentType: 'application/x-www-form-urlencoded', bytes: [...new TextEncoder().encode('grant_type=jwt-bearer&assertion=test')] },
    { body: Uint8Array.of(9, 0, 0x80, 0xff, 9).subarray(1, 4), contentType: 'application/octet-stream', bytes: [0, 0x80, 0xff] },
    { body: Uint8Array.of(0xff, 0, 0x80).buffer, contentType: 'application/vnd.example.raw', bytes: [0xff, 0, 0x80] },
])('preserves request bytes in server-routed nativeFetch ($contentType)', async test => {
    fetchMock.mockResolvedValue(new Response('received'))
    await fetchNative('https://provider.example/request', {
        method: 'POST', body: test.body, headers: { 'Content-Type': test.contentType },
        llmExecutionPolicy: { kind: 'ephemeral', durability: 'off', providerRoute: 'server' },
    })
    const [url, options] = fetchMock.mock.lastCall!
    expect(url).toBe(PROXY_PATH)
    expect([...new Uint8Array(await new Response(options.body).arrayBuffer())]).toEqual(test.bytes)
    expect(new Headers(options.headers).get('content-type')).toBe('application/octet-stream')
    const targetHeaders = new Headers(JSON.parse(decodeURIComponent(options.headers['risu-header'])))
    expect(targetHeaders.get('content-type')).toBe(test.contentType)
})

it('bounds a silent direct plugin request without duplicating its POST through the proxy', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const failed = expect(fetchNative('https://provider.example/generate', { body: '{}' }))
        .rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    await failed
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
})

it('keeps the existing network fallback and bounds the authenticated proxy response', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('CORS'))
        .mockImplementationOnce(() => new Promise(() => {}))
    const failed = expect(fetchNative('https://provider.example/generate', { body: '{}' }))
        .rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    await failed
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(PROXY_PATH)
    expect(fetchMock.mock.calls[1][1].headers['risu-auth']).toBe('token')
    expect(vi.getTimerCount()).toBe(0)
})

it('blocks redirects on an explicitly direct plugin request', async () => {
    fetchMock.mockRejectedValue(new TypeError('redirect blocked'))
    await expect(fetchNative('http://localhost:8188/prompt', {
        body: '{}', redirect: 'error',
        llmExecutionPolicy: { kind: 'ephemeral', durability: 'off', providerRoute: 'direct' },
    })).rejects.toThrow('redirect blocked')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error')
    expect(mocks.auth).not.toHaveBeenCalled()
})

it('respects a longer request timeout for a response body that stops sending data', async () => {
    const duration = DEFAULT_REQUEST_TIMEOUT_MS * 2
    fetchMock.mockResolvedValue(new Response(new ReadableStream()))
    const response = await fetchNative('https://provider.example/generate', { body: '{}', requestTimeoutMs: duration })
    let finished = false
    const failed = expect(response.text().finally(() => { finished = true }))
        .rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    await failed
    expect(fetchMock).toHaveBeenCalledOnce()
})

it('leaves durable generation deadlines with Revenant', async () => {
    let finish: (response: Response) => void
    mocks.generation.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const request = fetchNative('https://provider.example/generate', {
        body: '{}', interceptor: 'model_preset', llmExecutionPolicy: WORKFLOW_LLM_EXECUTION,
        generationRequest: {
            job: { chatId: 'g', jobType: 'model' },
            workflow: { workflowId: 'w', executionId: 'e', stepKey: 'model.main' },
        },
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS * 2)
    finish!(new Response('done'))
    expect(await (await request).text()).toBe('done')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
})

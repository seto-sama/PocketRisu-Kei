import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../../shared/requestTimeout.mjs'

const mocks = vi.hoisted(() => ({ generation: vi.fn(), auth: vi.fn() }))
vi.mock('../process/revenant/transport', () => ({ fetchViaGenerationJob: mocks.generation }))
vi.mock('../stores.svelte', () => ({ DBState: { db: {} }, bodyIntercepterStore: [] }))
vi.mock('../storage/autoStorage', () => ({ forageStorage: { createAuth: mocks.auth } }))
import { fetchNative } from './nativeFetch'
import { WORKFLOW_LLM_EXECUTION } from './transportTypes'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    mocks.auth.mockResolvedValue('token')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

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
    expect(fetchMock.mock.calls[1][0]).toBe('/proxy2')
    expect(fetchMock.mock.calls[1][1].headers['risu-auth']).toBe('token')
    expect(vi.getTimerCount()).toBe(0)
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
            job: { chatId: 'g', jobType: 'model', isContinuation: false },
            workflow: { workflowId: 'w', executionId: 'e', stepKey: 'model.main' },
        },
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS * 2)
    finish!(new Response('done'))
    expect(await (await request).text()).toBe('done')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
})

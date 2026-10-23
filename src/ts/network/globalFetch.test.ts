import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PROXY_PATH } from '../../../shared/proxy.mjs'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), native: vi.fn() }))
vi.mock('../storage/autoStorage', () => ({ forageStorage: { createAuth: mocks.auth } }))
vi.mock('../stores.svelte', () => ({ bodyIntercepterStore: [] }))
vi.mock('./nativeFetch', () => ({ fetchNative: mocks.native }))
import { globalFetch } from './globalFetch'
import { bodyIntercepterStore } from '../stores.svelte'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{"value":7}'))
    vi.stubGlobal('fetch', fetchMock)
    mocks.auth.mockResolvedValue('token')
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.useRealTimers()
    bodyIntercepterStore.length = 0
})

it.each([
    { body: { text: '한글' }, encoded: '{"text":"한글"}', contentType: 'application/json' },
    { body: new URLSearchParams({ code: 'a+b', grant_type: 'authorization_code' }), encoded: 'code=a%2Bb&grant_type=authorization_code', contentType: 'application/x-www-form-urlencoded' },
])('preserves legacy $contentType requests through the shared proxy transport', async ({ body, encoded, contentType }) => {
    const headers = { Authorization: 'Bearer provider' }
    expect(await globalFetch('https://provider.example/token', { body, headers })).toMatchObject({ ok: true, data: { value: 7 } })
    const [path, options] = fetchMock.mock.lastCall!
    expect(path).toBe(PROXY_PATH)
    expect(options.body).toBe(encoded)
    expect(options.headers['risu-auth']).toBe('token')
    const targetHeaders = new Headers(JSON.parse(decodeURIComponent(options.headers['risu-header'])))
    expect(targetHeaders.get('authorization')).toBe('Bearer provider')
    expect(targetHeaders.get('content-type')).toBe(contentType)
    expect(headers).toEqual({ Authorization: 'Bearer provider' })
})

it('sends bodyless GET requests and preserves raw binary results', async () => {
    fetchMock.mockResolvedValueOnce(new Response(Uint8Array.of(0, 128, 255)))
    const result = await globalFetch('https://provider.example/image', { method: 'GET', rawResponse: true })
    expect(fetchMock.mock.lastCall![1].body).toBeUndefined()
    expect(result).toMatchObject({ ok: true, status: 200, data: Uint8Array.of(0, 128, 255) })
})

it('keeps explicitly direct requests out of the server proxy', async () => {
    await globalFetch('https://provider.example/data', { method: 'GET', plainFetchForce: true })
    expect(fetchMock.mock.lastCall![0]).toBe('https://provider.example/data')
    expect(mocks.auth).not.toHaveBeenCalled()
})

it('applies interceptors once without mutating the caller body', async () => {
    const callback = vi.fn(async () => ({ transformed: true }))
    bodyIntercepterStore.push({ callback } as any)
    const options = { body: { original: true }, interceptor: 'service' }
    await globalFetch('https://provider.example/data', options)
    expect(callback).toHaveBeenCalledOnce()
    expect(fetchMock.mock.lastCall![1].body).toBe('{"transformed":true}')
    expect(options.body).toEqual({ original: true })
})

it('keeps durable generation in nativeFetch and preserves its text result', async () => {
    mocks.native.mockResolvedValueOnce(new Response('provider output'))
    const generationRequest = { job: { chatId: 'chat', jobType: 'model' as const } }
    const result = await globalFetch('https://provider.example/generate', {
        body: {}, interceptor: 'provider', generationRequest,
        llmExecutionPolicy: { kind: 'single', durability: 'required', providerRoute: 'server' },
    })
    expect(mocks.native).toHaveBeenCalledWith('https://provider.example/generate', expect.objectContaining({ generationRequest }))
    expect(result).toMatchObject({ ok: true, data: 'provider output' })
    expect(fetchMock).not.toHaveBeenCalled()
})

it('returns the legacy failure result when proxy authentication is unavailable', async () => {
    mocks.auth.mockResolvedValueOnce(null)
    const result = await globalFetch('https://provider.example/data', { body: {} })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
})

it('cancels a silent server request at its deadline without retrying', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce(() => new Promise(() => {}))
    const request = globalFetch('https://provider.example/data', { body: {}, requestTimeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(25)
    expect(await request).toMatchObject({ ok: false, status: 400 })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
})

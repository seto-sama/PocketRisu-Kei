import { afterEach, describe, expect, it, vi } from 'vitest'
const { decryptAccountBackup } = require('./accountBackup.cjs')
const marker = Buffer.from(JSON.stringify({ type: 'account', time: 1788710000000 }))
afterEach(() => vi.useRealTimers())

describe('account backup key retrieval', () => {
    it.each(['invalid json', '{}', '{"type":"account","time":-1}', '{"type":"account","time":"123"}', '{"type":"other","time":123}'])('rejects unsupported metadata before network access: %s', async value => {
        const fetchImpl = vi.fn()
        await expect(decryptAccountBackup(Buffer.alloc(16), Buffer.from(value), { fetchImpl }))
            .rejects.toMatchObject({ code: 'BACKUP_ENCRYPTION_METADATA_INVALID' })
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it.each([403, 500])('reports HTTP %s without exposing the server response body', async status => {
        const fetchImpl = vi.fn(async () => new Response('private server response', { status }))
        const failed = decryptAccountBackup(Buffer.alloc(16), marker, { fetchImpl })
        await expect(failed).rejects.toMatchObject({ code: 'BACKUP_ENCRYPTION_KEY_UNAVAILABLE', message: expect.stringContaining(`HTTP ${status}`) })
        await expect(failed).rejects.not.toThrow('private server response')
        expect(fetchImpl).toHaveBeenCalledOnce()
        const [url, init] = fetchImpl.mock.calls[0] as any
        expect(String(url)).toBe('https://sv.risuai.xyz/cryptokey?key=1788710000000')
        expect(init.redirect).toBe('error')
        expect(init.body).toBeUndefined()
        expect(init.headers).toEqual({ accept: 'application/json' })
    })

    it.each(['not json', '{}', '{"key":1}', '{"key":""}'])('rejects invalid key responses: %s', async body => {
        await expect(decryptAccountBackup(Buffer.alloc(16), marker, { fetchImpl: async () => new Response(body) }))
            .rejects.toMatchObject({ code: 'BACKUP_ENCRYPTION_KEY_UNAVAILABLE' })
    })

    it.each(['headers', 'body'])('bounds a hung key response during %s', async phase => {
        vi.useFakeTimers()
        const fetchImpl = vi.fn(() => phase === 'headers' ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream())))
        const failed = expect(decryptAccountBackup(Buffer.alloc(16), marker, { fetchImpl }))
            .rejects.toMatchObject({ code: 'BACKUP_ENCRYPTION_KEY_UNAVAILABLE' })
        await vi.advanceTimersByTimeAsync(30_000)
        await failed
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
    })
})

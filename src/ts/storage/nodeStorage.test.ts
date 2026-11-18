import { Buffer } from 'buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encode, decode } from 'msgpackr/index-no-eval'

vi.mock('src/lang', () => ({ language: {} }))
const alertInput = vi.hoisted(() => vi.fn())
vi.mock('../alert', () => ({
    alertInput,
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))

const { NodeStorage } = await import('./nodeStorage')

afterEach(() => {
    vi.unstubAllGlobals()
})

// Login state is page-wide, so auth tests start from a fresh module.
async function unauthenticatedNodeStorage() {
    vi.resetModules()
    return (await import('./nodeStorage')).NodeStorage
}

it('shares one login across storage instances, so a retry after a wrong password is the last prompt', async () => {
    const logins = ['wrong', 'right']
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === '/api/test_auth') return Response.json({ status: 'incorrect' })
        if (url === '/api/crypto') return new Response(`digest:${JSON.parse(String(init.body)).data}`)
        if (url === '/api/login') {
            return JSON.parse(String(init.body)).password === 'digest:right'
                ? Response.json({ status: 'success', token: 'jwt' })
                : Response.json({ code: 'AUTH_INVALID_PASSWORD' }, { status: 401 })
        }
        return Response.json({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    alertInput.mockImplementation(async () => logins.shift())

    const Storage = await unauthenticatedNodeStorage()
    const main = new Storage()
    await expect(main.createAuth()).rejects.toThrow()
    await expect(main.createAuth()).resolves.toBe('jwt')
    await expect(new Storage().createAuth()).resolves.toBe('jwt')
    expect(alertInput).toHaveBeenCalledTimes(2)
})

describe('NodeStorage patch transport', () => {
    it('does not send an empty projection delta', async () => {
        const storage = new NodeStorage()
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        await expect(storage.patchDatabase({ changes: [] })).resolves.toEqual({ success: true })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('loads and caches the relational database projection', async () => {
        const storage = new NodeStorage()
        const pluginCustomStorage = { json: '{ "id": 9007199254740993, "text": "한글" }', count: 0, enabled: false, config: { theme: 'dark' } }
        const authFetch = vi.fn().mockResolvedValue(new Response(encode({
            database: { characters: [], pluginCustomStorage },
            etag: 'db-etag-4',
            revision: 4,
        }), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
        }))
        ;(storage as any).authFetch = authFetch

        await expect(storage.getDatabaseProjection()).resolves.toEqual({
            database: { characters: [], pluginCustomStorage },
            etag: 'db-etag-4',
            revision: 4,
        })
        expect(storage._lastDbEtag).toBe('db-etag-4')
        expect(storage._lastDbRevision).toBe(4)
        expect(authFetch).toHaveBeenCalledWith('/api/database', {
            method: 'GET',
            headers: { accept: 'application/octet-stream' },
        })
    })

    it('uses PATCH /api/database for projection commits', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            etag: 'db-etag-5',
            revision: 5,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        ;(storage as any).authFetch = authFetch
        const payload = {
            patch: [{ op: 'replace', path: '/language', value: 'ko' }],
            expectedHash: 'hash-4',
        }

        await expect(storage.patchDatabase(payload)).resolves.toEqual({
            success: true,
            etag: 'db-etag-5',
            revision: 5,
        })
        expect(authFetch).toHaveBeenCalledWith('/api/database', {
            method: 'PATCH',
            body: encode(payload),
            headers: { 'content-type': 'application/octet-stream' },
        })
    })

    it('keeps the same plugin-storage projection mask for reads and patches', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn()
            .mockResolvedValueOnce(new Response(encode({
                database: { characters: [], pluginCustomStorage: {} },
                etag: 'masked-etag',
                revision: 2,
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                etag: 'next-etag',
                revision: 3,
            }), { status: 200 }))
        ;(storage as any).authFetch = authFetch
        storage.setPluginStorageExclusion({
            pluginNames: ['메모리 플러그인'],
            unclassified: true,
        })

        await storage.getDatabaseProjection()
        await storage.patchDatabase({
            patch: [{ op: 'replace', path: '/language', value: 'ko' }],
            expectedHash: 'masked-hash',
        })

        const readHeader = authFetch.mock.calls[0][1].headers['x-risu-plugin-storage-exclusion']
        const patchHeader = authFetch.mock.calls[1][1].headers['x-risu-plugin-storage-exclusion']
        expect(patchHeader).toBe(readHeader)
        expect(readHeader).toMatch(/^[\x20-\x7e]+$/)
        expect(JSON.parse(readHeader)).toEqual({
            plugins: ['메모리 플러그인'],
            unclassified: true,
        })
    })

    it('reports a first-run initialization race without overwriting it', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            currentEtag: 'winner-etag',
            currentRevision: 1,
        }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
        }))
        ;(storage as any).authFetch = authFetch

        await expect(storage.initializeDatabase({ characters: [] }, 0)).resolves.toEqual({
            success: false,
            conflict: true,
            etag: 'winner-etag',
            revision: 1,
        })
        expect(storage._lastDbEtag).toBe('winner-etag')
        expect(storage._lastDbRevision).toBe(1)
        const request = authFetch.mock.calls[0][1]
        expect(decode(request.body)).toEqual({ database: { characters: [] }, expectedRevision: 0 })
        expect(request.headers['content-type']).toBe('application/octet-stream')
    })
})

it('retries shared authentication after header and response-body timeouts', async () => {
    const Storage = await unauthenticatedNodeStorage()
    vi.useFakeTimers()
    try {
        const storage = new Storage()
        const fetchMock = vi.fn()
            .mockImplementationOnce(() => new Promise(() => {}))
            .mockResolvedValueOnce(new Response(new ReadableStream()))
            .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', token: 'token' })))
            .mockResolvedValueOnce(new Response('{}'))
        vi.stubGlobal('fetch', fetchMock)

        for (let attempt = 0; attempt < 2; attempt++) {
            const failed = expect(storage.createAuth()).rejects.toMatchObject({ name: 'TimeoutError' })
            await vi.advanceTimersByTimeAsync(30_000)
            await failed
        }
        await expect(storage.createAuth()).resolves.toBe('token')
    } finally {
        vi.useRealTimers()
    }
})

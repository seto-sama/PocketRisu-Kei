import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))

const { NodeStorage } = await import('./nodeStorage')

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('NodeStorage patch transport', () => {
    it('does not send an empty JSON Patch', async () => {
        const storage = new NodeStorage()
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        await expect(storage.patchItem('database/database.bin', {
            patch: [],
            expectedHash: 'stale-hash',
        })).resolves.toEqual({ success: true })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('loads and caches the relational database projection', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            database: { characters: [] },
            etag: 'db-etag-4',
            revision: 4,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        ;(storage as any).authFetch = authFetch

        await expect(storage.getDatabaseProjection()).resolves.toEqual({
            database: { characters: [] },
            etag: 'db-etag-4',
            revision: 4,
        })
        expect(storage._lastDbEtag).toBe('db-etag-4')
        expect(storage._lastDbRevision).toBe(4)
        expect(authFetch).toHaveBeenCalledWith('/api/database', {
            method: 'GET',
            headers: { accept: 'application/json' },
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
            persistWarning: undefined,
        })
        expect(authFetch).toHaveBeenCalledWith('/api/database', {
            method: 'PATCH',
            body: JSON.stringify(payload),
            headers: { 'content-type': 'application/json' },
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
    })
})

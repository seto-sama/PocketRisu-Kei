import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: () => new Uint8Array([1]),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))

import { ConflictError, NodeStorage } from './nodeStorage'

const bytes = new Uint8Array([1, 2, 3])
const patch = { patch: [{ op: 'replace', path: '/language', value: 'ko' }], expectedHash: 'base' }
let storage: NodeStorage
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
    storage = new NodeStorage()
    vi.spyOn(storage as any, 'checkAuth').mockResolvedValue(undefined)
    vi.spyOn(storage, 'createAuth').mockResolvedValue('auth-token')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('storage request integration', () => {
    it.each([
        ['asset', () => storage.setItem('assets/a.png', bytes)],
        ['bulk asset', () => storage.setItems([{ key: 'assets/a.png', value: bytes }])],
        ['database patch', () => storage.patchDatabase(patch)],
        ['chat', () => storage.saveChatContent('character', 0, 'chat', {})],
        ['initial database', () => storage.initializeDatabase({})],
        ['inlay encoding', () => storage.encodeInlayWebp(bytes, { lossy: true, quality: 80 })],
    ] as const)('surfaces HTTP 413 for %s without resending', async (_name, send) => {
        fetchMock.mockResolvedValue(new Response('<html>too large</html>', { status: 413 }))
        await expect(send()).rejects.toMatchObject({ status: 413, message: expect.stringContaining('request-size limit') })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['asset', () => storage.setItem('assets/a.png', bytes)],
        ['bulk asset', () => storage.setItems([{ key: 'assets/a.png', value: bytes }])],
    ] as const)('returns transient %s failures without retrying', async (_name, send) => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'upstream unavailable' }), { status: 503 }))
        await expect(send()).rejects.toMatchObject({ status: 503, serverMessage: 'upstream unavailable' })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const networkError = new TypeError('Failed to fetch')
        fetchMock.mockRejectedValueOnce(networkError)
        await expect(send()).rejects.toBe(networkError)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('preserves ETag conflicts instead of retrying or turning them into generic failures', async () => {
        fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'conflict', currentEtag: 'server' }), { status: 409 }))
        await expect(storage.patchDatabase(patch)).resolves.toMatchObject({ conflict: true, etag: 'server' })
        await expect(storage.saveChatContent('character', 0, 'chat', {})).rejects.toBeInstanceOf(ConflictError)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('retains server rejection details even in an HTTP 200 response', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'write rejected' })))
        await expect(storage.patchDatabase(patch)).rejects.toMatchObject({
            status: 200, operation: 'patchDatabase', serverMessage: 'write rejected',
        })
    })
})

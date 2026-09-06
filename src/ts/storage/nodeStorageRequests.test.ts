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


it('fetches fresh cleanup references without replacing the autosave baseline', async () => {
    storage.setDbEtag('accepted')
    storage.setDbRevision(7)
    const result = { kind: 'translation', scannedAt: 1, used: [true] }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(result)))
    expect(await storage.scanContentReferences('translation', ['known text'])).toEqual({ kind: 'translation', scannedAt: 1, keys: ['known text'] })
    expect(fetchMock).toHaveBeenCalledWith('/api/database/content-references', expect.objectContaining({ method: 'POST', cache: 'no-store', body: JSON.stringify({ kind: 'translation', candidates: ['known text'] }) }))
    expect(storage._lastDbEtag).toBe('accepted')
    expect(storage._lastDbRevision).toBe(7)
})

it('refuses cleanup when the server scan fails or returns malformed data', async () => {
    fetchMock.mockResolvedValueOnce(new Response('failed', { status: 500 }))
    await expect(storage.scanContentReferences('inlay', ['known'])).rejects.toMatchObject({ status: 500 })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({})))
    await expect(storage.scanContentReferences('inlay', ['known'])).rejects.toThrow('Invalid content reference scan response')
})

it.each([
    { kind: 'translation', scannedAt: 1, keys: ['secret server text'] },
    { kind: 'translation', scannedAt: 1, used: [] },
    { kind: 'translation', scannedAt: 1, used: ['true'] },
])('rejects legacy or incomplete reference results: %j', async response => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response)))
    await expect(storage.scanContentReferences('translation', ['known']))
        .rejects.toThrow('Invalid content reference scan response')
})

it('never propagates unsolicited server text or ids from reference responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        kind: 'translation', scannedAt: 1, used: [true, false], keys: ['server secret'], totalMessages: 999,
    })))
    expect(await storage.scanContentReferences('translation', ['known', 'unused']))
        .toEqual({ kind: 'translation', scannedAt: 1, keys: ['known'] })
})

it('carries hash diagnostics through the existing patch request without another fetch', async () => {
    const hashDiagnostics = { keys: { language: 'abc' }, characters: [{ id: 'a', hash: 'def' }] }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        code: 'DATABASE_HASH_MISMATCH', currentHash: '123', currentRevision: 9,
        currentEtag: 'server', hashDiagnostics,
    }), { status: 409 }))
    expect(await storage.patchDatabase(patch)).toMatchObject({
        conflict: true, conflictCode: 'DATABASE_HASH_MISMATCH', currentHash: '123',
        revision: 9, hashDiagnostics,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(patch)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        hashDiagnostics: { keys: null, characters: [] },
    }), { status: 409 }))
    expect(await storage.patchDatabase(patch)).toMatchObject({ conflict: true, hashDiagnostics: undefined })
})

it('ends a chat header timeout without replaying the request', async () => {
    vi.useFakeTimers()
    try {
        fetchMock.mockImplementation(() => new Promise(() => {}))
        const failed = expect(storage.fetchChatContent('character', 2, 'chat-id'))
            .rejects.toMatchObject({ name: 'TimeoutError' })
        await vi.advanceTimersByTimeAsync(30_000)
        await failed
        await vi.advanceTimersByTimeAsync(30_000)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][0]).toBe('/api/chat-content/character/2')
        expect(fetchMock.mock.calls[0][1].headers.get('x-chat-id')).toBe('chat-id')
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
})

it('bounds auth preflight without dispatching a late chat request', async () => {
    vi.useFakeTimers()
    try {
        let finishAuth: () => void
        vi.mocked((storage as any).checkAuth).mockImplementation(() => new Promise<void>(resolve => { finishAuth = resolve }))
        const failed = expect(storage.fetchChatContent('c', 0, 'chat')).rejects.toMatchObject({ name: 'TimeoutError' })
        await vi.advanceTimersByTimeAsync(30_000)
        await failed
        finishAuth!()
        await vi.advanceTimersByTimeAsync(0)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
})

it.each([503, 404])('does not retry chat HTTP %s responses', async status => {
    fetchMock.mockResolvedValue(new Response('unavailable', { status }))
    if (status === 404) expect(await storage.fetchChatContent('c', 0, 'chat')).toBeNull()
    else await expect(storage.fetchChatContent('c', 0, 'chat')).rejects.toMatchObject({ status })
    expect(fetchMock).toHaveBeenCalledOnce()
})

it.each([
    ['BACKUP_ENCRYPTION_METADATA_INVALID', 'encryption metadata'],
    ['BACKUP_ENCRYPTION_KEY_UNAVAILABLE', 'decryption key'],
    ['BACKUP_DECRYPTION_FAILED', 'Could not decrypt'],
])('presents %s consistently for uploads and server-file restores', async (code, message) => {
    vi.spyOn(storage, 'prepareImport').mockResolvedValue(undefined)
    const event = JSON.stringify({ type: 'error', code, message: 'server fallback' }) + '\n'
    class BackupXHR {
        upload = {}
        status = 200
        responseText = ''
        onprogress?: () => void
        onload?: () => void
        open() {}
        setRequestHeader() {}
        send() {
            this.responseText = event.slice(0, 13)
            this.onprogress?.()
            this.responseText = event
            this.onload?.()
        }
    }
    vi.stubGlobal('XMLHttpRequest', BackupXHR)
    await expect(storage.importBackup(new Blob(['fixture']))).rejects.toThrow(message)
    fetchMock.mockResolvedValueOnce(new Response(event))
    await expect(storage.restoreServerBackup('fixture.bin')).rejects.toThrow(message)
})

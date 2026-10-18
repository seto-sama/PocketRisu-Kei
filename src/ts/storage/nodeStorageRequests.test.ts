import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))

import { changeLanguage } from 'src/lang'
import { ConflictError, NodeStorage } from './nodeStorage'
import { decodeAssetBatch, encodeAssetBatch } from './assetTransport'
import { decodeRisuSave } from './risuSave'
import { createDelta } from '../../../shared/guardedDelta.mjs'

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

it('hands backups and assets to the browser after refreshing only the session cookie', async () => {
    const downloads: { url: string, name: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
        downloads.push({ url: this.getAttribute('href')!, name: this.download })
    })
    fetchMock.mockResolvedValue(new Response('{}'))
    await storage.downloadBackupExport()
    await storage.downloadBackupExport({ mode: 'settings', moduleAssets: false })
    await storage.downloadBackupExport({ target: 'upstream' })
    await storage.downloadServerBackup('risu-backup-1.bin')
    await storage.downloadAsset('inlay/image', '한글.png')
    await storage.downloadDriveFile('자료/한글 &.bin')
    expect(downloads).toEqual([
        { url: '/api/backup/export', name: '' },
        { url: '/api/backup/export?mode=settings&moduleAssets=0', name: '' },
        { url: '/api/backup/export?target=upstream', name: '' },
        { url: '/api/backup/server/download/risu-backup-1.bin', name: '' },
        { url: `/api/asset/${Buffer.from('inlay/image').toString('hex')}?download=1&filename=${encodeURIComponent('한글.png')}`, name: '' },
        { url: `/api/drive/download?${new URLSearchParams({ path: '자료/한글 &.bin' })}`, name: '' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(downloads.length)
    for (const [url, request] of fetchMock.mock.calls) {
        expect(url).toBe('/api/session')
        expect(request.method).toBe('POST')
        const authHeaders = new Headers(request.headers)
        expect(authHeaders.get('risu-auth')).toBe('auth-token')
        expect(authHeaders.has('x-sync-client-id')).toBe(false)
        expect(authHeaders.has('x-session-id')).toBe(false)
    }
})

it('does not start a download when session refresh fails', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fetchMock.mockResolvedValue(new Response('{"code":"AUTH_REQUIRED"}', { status: 401 }))
    await expect(storage.downloadBackupExport()).rejects.toMatchObject({ status: 401 })
    expect(click).not.toHaveBeenCalled()
})

it('carries folder merge comparisons, choices, and completed moves through the drive API', async () => {
    const entry = { path: 'target/a.txt', name: 'a.txt', type: 'file', size: 12, createdAt: 1, modifiedAt: 2 }
    const plan = { revision: 'revision', conflicts: [{ path: entry.path, existing: entry, incoming: { ...entry, path: 'source/a.txt' } }] }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'DRIVE_MERGE_CONFLICT', details: plan }), { status: 409 }))
    await expect(storage.renameDriveEntry('source', 'target', 'overwrite')).rejects.toMatchObject({
        code: 'DRIVE_MERGE_CONFLICT', details: plan,
    })

    const merge = { revision: plan.revision, choices: { [entry.path]: 'both' as const } }
    const result = { entry, moves: [{ from: 'source/a.txt', to: 'target/a (1).txt' }] }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result)))
    expect(await storage.renameDriveEntry('source', 'target', 'overwrite', merge, '')).toEqual(result)
    const [url, request] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/drive/rename')
    expect(request.method).toBe('PATCH')
    expect(JSON.parse(request.body)).toEqual({ path: 'source', name: 'target', conflict: 'overwrite', merge, destination: '' })
})

describe('storage request integration', () => {
    it('sends the same guarded changes for database and chat saves', async () => {
        const delta = { changes: createDelta({ note: 'before' }, { note: 'after' }) }
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, etag: 'db' })))
        await storage.patchDatabase(delta)
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, etag: 'chat' })))
        expect(await storage.patchChatContent('character', 99, 'stable-chat', delta)).toEqual({ etag: 'chat' })
        for (const [, request] of fetchMock.mock.calls) {
            expect(request.method).toBe('PATCH')
            expect(JSON.parse(request.body)).toEqual(delta)
            expect(new Headers(request.headers).get('content-type')).toBe('application/json')
            expect(new Headers(request.headers).has('x-chat-if-match')).toBe(false)
        }
        expect(new Headers(fetchMock.mock.calls[1][1].headers).get('x-chat-id')).toBe('stable-chat')
    })

    it('pairs each fetched body with its own ETag when decoding completes out of order', async () => {
        let release!: (chat: object) => void
        vi.mocked(decodeRisuSave)
            .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
            .mockResolvedValueOnce({ id: 'chat', note: 'new' })
        fetchMock
            .mockResolvedValueOnce(new Response(bytes, { headers: { 'x-chat-etag': 'old-etag' } }))
            .mockResolvedValueOnce(new Response(bytes, { headers: { 'x-chat-etag': 'new-etag' } }))
        const old = storage.fetchChatState('c', 0, 'chat')
        await vi.waitFor(() => expect(release).toBeDefined())
        expect(await storage.fetchChatState('c', 0, 'chat')).toMatchObject({
            chat: { note: 'new' }, baseline: { note: 'new' }, etag: 'new-etag',
        })
        release({ id: 'chat', note: 'old' })
        expect(await old).toMatchObject({ chat: { note: 'old' }, baseline: { note: 'old' }, etag: 'old-etag' })
    })

    it('uses the binary asset protocol for reads and writes', async () => {
        const entries = [{ key: 'assets/한글.png', value: Uint8Array.of(0, 128, 255) }]
        fetchMock.mockResolvedValueOnce(new Response('{}'))
        await storage.setItems(entries)
        const upload = fetchMock.mock.calls[0][1] as RequestInit
        expect(new Headers(upload.headers).get('content-type')).toBe('application/octet-stream')
        expect(decodeAssetBatch(upload.body as Uint8Array)).toEqual(entries)

        fetchMock.mockResolvedValueOnce(new Response(encodeAssetBatch(entries)))
        const downloaded = await storage.getItems(entries.map(entry => entry.key))
        expect(downloaded.map(entry => ({ key: entry.key, value: [...entry.value] })))
            .toEqual([{ key: 'assets/한글.png', value: [0, 128, 255] }])
    })
    it.each([
        ['asset', () => storage.setItem('assets/a.png', bytes)],
        ['bulk asset', () => storage.setItems([{ key: 'assets/a.png', value: bytes }])],
        ['database patch', () => storage.patchDatabase(patch)],
        ['chat', () => storage.patchChatContent('character', 0, 'chat', { changes: [] })],
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

    it('preserves field conflicts instead of retrying or turning them into generic failures', async () => {
        fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'conflict', currentEtag: 'server' }), { status: 409 }))
        await expect(storage.patchDatabase(patch)).resolves.toMatchObject({ conflict: true, etag: 'server' })
        await expect(storage.patchChatContent('character', 0, 'chat', { changes: [] })).rejects.toBeInstanceOf(ConflictError)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('localizes the stable chat conflict returned by the server', async () => {
        changeLanguage('ko')
        try {
            fetchMock.mockResolvedValue(new Response(JSON.stringify({
                code: 'CHAT_CONTENT_CHANGED',
                error: 'Chat content changed on another client', currentEtag: 'server',
            }), { status: 409 }))
            await expect(storage.patchChatContent('character', 0, 'chat', { changes: [] }))
                .rejects.toMatchObject({
                    code: 'CHAT_CONTENT_CHANGED',
                    message: expect.stringContaining('다른 클라이언트에 의한 수정사항이 있습니다'),
                })
        } finally {
            changeLanguage('en')
        }
    })

    it('routes backup and login responses through the common coded error parser', async () => {
        changeLanguage('ko')
        try {
            fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
                code: 'BACKUP_IMPORT_IN_PROGRESS', error: 'server diagnostic',
            }), { status: 409 }))
            await expect(storage.prepareImport(1)).rejects.toThrow('다른 백업 가져오기 또는 복원이 이미 진행 중입니다.')

            fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
                code: 'BACKUP_NOT_FOUND', error: 'server diagnostic',
            }), { status: 404 }))
            await expect(storage.restoreServerBackup('missing.bin')).rejects.toThrow('백업 파일을 찾을 수 없습니다.')

            fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
                code: 'AUTH_INVALID_PASSWORD', error: 'server diagnostic',
            }), { status: 401 }))
            await expect((storage as any).loginWithPassword('wrong')).rejects.toThrow('비밀번호가 잘못되었습니다.')
        } finally {
            changeLanguage('en')
        }
    })

    it('retries authentication from stable codes only', async () => {
        const shouldRetry = (body: object, status = 401) =>
            (storage as any).shouldRetryAuth(new Response(JSON.stringify(body), { status }))
        await expect(shouldRetry({ code: 'AUTH_TOKEN_EXPIRED' })).resolves.toBe(true)
        await expect(shouldRetry({ code: 'AUTH_INVALID_TOKEN' })).resolves.toBe(true)
        await expect(shouldRetry({ error: 'Token Expired' })).resolves.toBe(false)
        await expect(shouldRetry({ code: 'AUTH_INVALID_TOKEN' }, 400)).resolves.toBe(false)
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
        const failed = expect(storage.fetchChatState('character', 2, 'chat-id'))
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
        const failed = expect(storage.fetchChatState('c', 0, 'chat')).rejects.toMatchObject({ name: 'TimeoutError' })
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
    if (status === 404) expect(await storage.fetchChatState('c', 0, 'chat')).toBeNull()
    else await expect(storage.fetchChatState('c', 0, 'chat')).rejects.toMatchObject({ status })
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

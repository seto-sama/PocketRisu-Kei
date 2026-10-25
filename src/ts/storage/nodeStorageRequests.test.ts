import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encode, decode } from 'msgpackr/index-no-eval'

vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))

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

it('hands existing backups and assets to the browser after refreshing only the session cookie', async () => {
    const downloads: { url: string, name: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
        downloads.push({ url: this.getAttribute('href')!, name: this.download })
    })
    fetchMock.mockResolvedValue(new Response('{}'))
    await storage.downloadServerBackup('risu-backup-1.bin')
    await storage.downloadAsset('inlay/image', '한글.png')
    await storage.downloadDriveFile('자료/한글 &.bin')
    expect(downloads).toEqual([
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
    await expect(storage.downloadServerBackup('risu-backup-1.bin')).rejects.toMatchObject({ status: 401 })
    expect(click).not.toHaveBeenCalled()
})

it('does not start a download when backup preparation fails', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(new Response('{"code":"DATABASE_LOCKED"}', { status: 503 }))
    await expect(storage.downloadBackupExport()).rejects.toMatchObject({ status: 503, code: 'DATABASE_LOCKED' })
    expect(click).not.toHaveBeenCalled()
})

it('receives compression progress before downloading, across split UTF-8 lines', async () => {
    let downloadedUrl = ''
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        downloadedUrl = this.getAttribute('href')!
    })
    let controller!: ReadableStreamDefaultController<Uint8Array>
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } })))
        .mockResolvedValueOnce(new Response('{}'))
    const progress = vi.fn()
    let finished = false
    const downloading = storage.downloadBackupExport({ mode: 'settings', moduleAssets: false }, progress)
        .then(() => { finished = true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/backup/export/prepare?mode=settings&moduleAssets=0')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('accept')).toBe('application/x-ndjson')
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('risu-auth')).toBe('auth-token')
    expect(click).not.toHaveBeenCalled()
    expect(finished).toBe(false)

    const event = { stage: 'compressing', bytes: 10, totalBytes: 20, backupBytes: 105, label: '압축' }
    const data = new TextEncoder().encode(JSON.stringify({ type: 'progress', ...event }) + '\n')
    const split = data.indexOf(0xec) + 1
    controller.enqueue(data.subarray(0, split))
    controller.enqueue(data.subarray(split))
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(expect.objectContaining(event)))
    expect(click).not.toHaveBeenCalled()
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'done', url: '/api/backup/export?prepared=ready' })))
    controller.close()
    await downloading
    expect(click).toHaveBeenCalledOnce()
    expect(downloadedUrl).toBe('/api/backup/export?prepared=ready')
    expect(finished).toBe(true)
})

it.each([
    [{ type: 'progress', stage: 'saving' }],
    [{ type: 'error', code: 'BACKUP_NOT_FOUND', message: 'missing' }],
])('does not download an incomplete or failed preparation stream: %j', async (event) => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(event) + '\n'))
    await expect(storage.downloadBackupExport()).rejects.toThrow()
    expect(click).not.toHaveBeenCalled()
})

it('transfers file formats with authentication and preserves binary values', async () => {
    const value = { name: '한글', bytes }
    fetchMock.mockResolvedValueOnce(new Response(bytes))
    expect(await storage.encodeFile('preset', value)).toEqual(bytes)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/file-formats/preset/encode')
    const sent = decode(fetchMock.mock.calls[0][1].body)
    expect(sent.name).toBe(value.name)
    expect(new Uint8Array(sent.bytes)).toEqual(bytes)
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('risu-auth')).toBe('auth-token')

    fetchMock.mockResolvedValueOnce(new Response(encode(value)))
    const received = await storage.decodeFile('preset', bytes)
    expect(received.name).toBe(value.name)
    expect(new Uint8Array(received.bytes)).toEqual(bytes)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/file-formats/preset/decode')

    fetchMock.mockResolvedValueOnce(new Response('{"code":"AUTH_REQUIRED"}', { status: 401 }))
    await expect(storage.decodeFile('save', bytes)).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' })
})

it('reads drive imports as authenticated files without starting a browser download', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    fetchMock.mockResolvedValueOnce(new Response(bytes))
    const file = await storage.readDriveFile('자료/한글 &.risum')
    expect(file.name).toBe('한글 &.risum')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/drive/download?${new URLSearchParams({ path: '자료/한글 &.risum' })}`)
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('risu-auth')).toBe('auth-token')
    expect(click).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce(new Response('{"code":"AUTH_REQUIRED"}', { status: 401 }))
    await expect(storage.readDriveFile('private.risup')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' })
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

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ entry })))
    expect(await storage.copyDriveEntry('source', 'target', 'overwrite', merge, '')).toEqual(entry)
    const [copyUrl, copyRequest] = fetchMock.mock.calls[2]
    expect(copyUrl).toBe('/api/drive/copy')
    expect(copyRequest.method).toBe('POST')
    expect(JSON.parse(copyRequest.body)).toEqual({ path: 'source', name: 'target', conflict: 'overwrite', merge, destination: '' })
})

describe('storage request integration', () => {
    it('sends the same guarded changes for database and chat saves', async () => {
        const delta = { changes: createDelta({ note: 'before' }, { note: 'after' }) }
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, etag: 'db' })))
        await storage.patchDatabase(delta)
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, etag: 'chat' })))
        expect(await storage.patchChatContent('character', 99, 'stable-chat', delta)).toEqual({ etag: 'chat' })
        for (const [index, [, request]] of fetchMock.mock.calls.entries()) {
            expect(request.method).toBe('PATCH')
            expect(index === 0 ? decode(request.body) : JSON.parse(request.body)).toEqual(delta)
            expect(new Headers(request.headers).get('content-type')).toBe(index === 0 ? 'application/octet-stream' : 'application/json')
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
    it('returns HTTP failures without resending requests', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response('<html>too large</html>', { status: 413 }))
            .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
            .mockResolvedValueOnce(new Response('missing', { status: 404 }))
        await expect(storage.patchDatabase(patch)).rejects.toMatchObject({ status: 413 })
        await expect(storage.fetchChatState('c', 0, 'chat')).rejects.toMatchObject({ status: 503 })
        expect(await storage.fetchChatState('c', 0, 'chat')).toBeNull()
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('preserves field conflicts instead of retrying or turning them into generic failures', async () => {
        fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'conflict', currentEtag: 'server' }), { status: 409 }))
        await expect(storage.patchDatabase(patch)).resolves.toMatchObject({ conflict: true, etag: 'server' })
        await expect(storage.patchChatContent('character', 0, 'chat', { changes: [] })).rejects.toBeInstanceOf(ConflictError)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('reauthenticates expired tokens but returns other authentication failures', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'AUTH_TOKEN_EXPIRED' }), { status: 401 }))
            .mockResolvedValueOnce(new Response(bytes))
        expect(new Uint8Array(await storage.getItem('assets/a.png'))).toEqual(bytes)

        fetchMock.mockClear()
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'AUTH_INVALID_PASSWORD' }), { status: 401 }))
        await expect(storage.getItem('assets/a.png')).rejects.toMatchObject({ code: 'AUTH_INVALID_PASSWORD' })
        expect(fetchMock).toHaveBeenCalledTimes(1)
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
    expect(decode(fetchMock.mock.calls[0][1].body)).toEqual(patch)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        hashDiagnostics: { keys: null, characters: [] },
    }), { status: 409 }))
    expect(await storage.patchDatabase(patch)).toMatchObject({ conflict: true, hashDiagnostics: undefined })
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

it('shares coded errors between uploaded and server-file backup restores', async () => {
    const code = 'BACKUP_DECRYPTION_FAILED'
    const message = 'Could not decrypt'
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

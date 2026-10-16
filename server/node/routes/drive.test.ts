import express from 'express'
import { createServer, request, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, link, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installDriveRoutes } from './drive.cjs'
import { isCloudflareTunnelRequest as detectCloudflareTunnelRequest } from '../remoteDatabaseFilter.cjs'
import { DRIVE_TRASH_DIRECTORY } from '../../../shared/trashRetention.mjs'

const tunnelUrl = 'https://private.example.com'
const isRemoteTunnelRequest = (req: unknown) => detectCloudflareTunnelRequest(req, tunnelUrl)

let directory: string
let root: string
let server: Server
let base: string
let stopTrashCleanup: () => void
const auth = { 'risu-auth': 'test-token' }
const trashPath = () => join(root, DRIVE_TRASH_DIRECTORY)

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'risu-drive-'))
    root = join(directory, 'drive')
    const app = express()
    app.use(express.json())
    app.use(express.text())
    const checkAuth = async (req, res) => {
        if (req.headers['risu-auth'] === auth['risu-auth']) return true
        res.status(401).json({ code: 'AUTH_REQUIRED' })
        return false
    }
    const driveRoutes = installDriveRoutes(app, {
        savePath: directory, checkAuth, checkDownloadAuth: checkAuth, isCloudflareTunnelRequest: isRemoteTunnelRequest,
    })
    stopTrashCleanup = driveRoutes.stopTrashCleanup
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }))
    server = createServer(app)
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/drive`
})

afterEach(async () => {
    await stopTrashCleanup()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
})

const get = (route = '', params: Record<string, string> = {}) => fetch(`${base}${route}?${new URLSearchParams(params)}`, { headers: auth })
const json = (route: string, body: object, method = 'POST') => fetch(base + route, {
    method, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const deleteDriveEntry = (path: string) => json('/entry', { path }, 'DELETE')
const emptyDriveTrash = () => json('/trash', {}, 'DELETE')
const upload = (name: string, body: BodyInit = 'contents', path = '', conflict = 'error') => fetch(`${base}/file?${new URLSearchParams({ path, name, conflict })}`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body,
})

const requestDrive = (route: string, method: string, extraHeaders: Record<string, string> = {}, body = '') => (
    new Promise<{ status: number, body: string }>((resolve, reject) => {
        const req = request(base + route, { method, headers: { ...auth, ...extraHeaders, 'content-length': Buffer.byteLength(body) } })
        req.on('error', reject)
        req.on('response', response => {
            let responseBody = ''
            response.setEncoding('utf8')
            response.on('data', chunk => { responseBody += chunk })
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body: responseBody }))
        })
        req.end(body)
    })
)

it('denies authenticated Drive access through Cloudflare tunnels before filesystem operations', async () => {
    await vi.waitFor(async () => expect((await stat(trashPath())).isDirectory()).toBe(true))
    await writeFile(join(root, 'existing.txt'), 'keep this file unchanged')
    await writeFile(join(trashPath(), 'keep.txt'), 'trash must remain unchanged')
    const beforeDrive = await readdir(root)
    const beforeSave = await readdir(directory)
    const beforeTrashManifest = await readFile(join(directory, 'drive-trash.json')).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
    })
    const operations: { route: string, method: string, headers?: Record<string, string>, body?: string }[] = [
        { route: '', method: 'GET' },
        { route: '/metadata?path=existing.txt', method: 'GET' },
        { route: '/download?path=existing.txt', method: 'GET' },
        { route: '/directory', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'created' }) },
        { route: '/rename', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'existing.txt', name: 'renamed.txt' }) },
        { route: '/entry', method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'existing.txt' }) },
        { route: '/trash', method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' },
        { route: '/file?name=created.txt', method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'new contents' },
    ]

    for (const operation of operations) {
        const response = await requestDrive(operation.route, operation.method, {
            host: 'preview.trycloudflare.com', ...operation.headers,
        }, operation.body)
        expect(response.status, `${operation.method} ${operation.route}`).toBe(403)
        expect(JSON.parse(response.body)).toMatchObject({ code: 'DRIVE_REMOTE_ACCESS_DENIED' })
    }
    for (const headers of [
        { host: '192.168.1.20', 'x-forwarded-host': 'preview.trycloudflare.com' },
        { host: 'private.example.com' },
    ]) {
        const response = await requestDrive('', 'GET', headers)
        expect(response.status).toBe(403)
        expect(JSON.parse(response.body)).toMatchObject({ code: 'DRIVE_REMOTE_ACCESS_DENIED' })
    }
    expect(await readdir(root)).toEqual(beforeDrive)
    expect(await readdir(directory)).toEqual(beforeSave)
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('keep this file unchanged')
    expect(await readdir(trashPath())).toEqual(['keep.txt'])
    expect(await readFile(join(trashPath(), 'keep.txt'), 'utf8')).toBe('trash must remain unchanged')
    expect(await readFile(join(directory, 'drive-trash.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)))
        .toEqual(beforeTrashManifest)

    const unauthorized = await fetch(base, { headers: { 'x-forwarded-host': 'preview.trycloudflare.com' } })
    expect(unauthorized.status).toBe(401)

    const tailscale = await requestDrive('', 'GET', {
        host: '100.64.0.8', 'x-forwarded-host': 'pocketrisu.tailnet.ts.net',
    })
    expect(tailscale.status).toBe(200)
    expect(JSON.parse(tailscale.body).entries).toEqual([expect.objectContaining({ name: 'existing.txt' })])
})

it('shares nested files, metadata and renames through the filesystem, including empty uploads', async () => {
    expect(await (await get()).json()).toEqual({ path: '', entries: [] })
    expect((await json('/directory', { name: '문서' })).status).toBe(201)
    const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 256)
    expect((await upload('한글 #&.bin', bytes, '문서')).status).toBe(201)
    expect((await upload('empty', '')).status).toBe(201)
    expect(await readFile(join(root, '문서', '한글 #&.bin'))).toEqual(Buffer.from(bytes))
    const renamed = '새 이름.bin'
    expect((await json('/rename', { path: '문서/한글 #&.bin', name: renamed }, 'PATCH')).status).toBe(200)
    expect((await json('/rename', { path: '문서', name: '자료' }, 'PATCH')).status).toBe(200)
    const metadata = await (await get('/metadata', { path: `자료/${renamed}` })).json()
    expect(metadata).toMatchObject({ path: `자료/${renamed}`, name: renamed, type: 'file', size: bytes.length, modifiedAt: expect.any(Number) })
    const listing = await (await get('', { path: '자료' })).json()
    expect(listing.entries).toEqual([metadata])
    const download = await get('/download', { path: `자료/${renamed}` })
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(download.headers.get('content-disposition')).toContain(encodeURIComponent(renamed))
    expect(download.headers.get('content-length')).toBe(String(bytes.length))
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
    const empty = await get('/download', { path: 'empty' })
    expect(empty.status).toBe(200)
    expect((await empty.arrayBuffer()).byteLength).toBe(0)
    expect((await get('/download', { path: '자료' })).status).toBe(403)
    expect((await get('', { path: 'missing' })).status).toBe(404)
})

it('requires a conflict choice before replacing existing names, including simultaneous uploads', async () => {
    await vi.waitFor(async () => expect((await stat(trashPath())).isDirectory()).toBe(true))
    const responses = await Promise.all([upload('same', 'first'), upload('same', 'second')])
    expect(responses.map(res => res.status).sort()).toEqual([201, 409])
    const stored = await readFile(join(root, 'same'), 'utf8')
    expect(['first', 'second']).toContain(stored)
    expect((await upload('same', 'replacement')).status).toBe(409)
    expect((await upload('other')).status).toBe(201)
    expect((await json('/rename', { path: 'other', name: 'same' }, 'PATCH')).status).toBe(409)
    expect((await json('/directory', { name: 'same' })).status).toBe(409)
    expect((await json('/directory', { name: 'folder' })).status).toBe(201)
    expect((await upload('folder')).status).toBe(409)
    expect(await readFile(join(root, 'same'), 'utf8')).toBe(stored)
    expect((await readdir(root)).sort()).toEqual(['folder', 'other', 'same', DRIVE_TRASH_DIRECTORY].sort())
})

it('overwrites only regular files when explicitly requested', async () => {
    await upload('report.txt', 'old')
    const response = await upload('report.txt', 'new contents', '', 'overwrite')
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ entry: { name: 'report.txt', size: 12 } })
    expect(await readFile(join(root, 'report.txt'), 'utf8')).toBe('new contents')
    await json('/directory', { name: 'folder' })
    expect((await upload('folder', 'data', '', 'overwrite')).status).toBe(409)
    expect((await stat(join(root, 'folder'))).isDirectory()).toBe(true)
    await writeFile(join(directory, 'private'), 'secret')
    await symlink(join(directory, 'private'), join(root, 'link'))
    await link(join(directory, 'private'), join(root, 'hard-link'))
    for (const name of ['link', 'hard-link']) expect((await upload(name, 'data', '', 'overwrite')).status).toBe(403)
    expect(await readFile(join(directory, 'private'), 'utf8')).toBe('secret')
})

it('creates an empty trash at startup, keeps it after emptying, and preserves moved files and folders', async () => {
    await vi.waitFor(async () => expect((await stat(trashPath())).isDirectory()).toBe(true))
    const firstListing = await get('', { path: DRIVE_TRASH_DIRECTORY })
    expect(firstListing.status).toBe(200)
    expect(await firstListing.json()).toEqual({ path: DRIVE_TRASH_DIRECTORY, entries: [] })
    expect(await readdir(trashPath())).toEqual([])
    expect((await emptyDriveTrash()).status).toBe(200)
    const emptyListing = await get('', { path: DRIVE_TRASH_DIRECTORY })
    expect(emptyListing.status).toBe(200)
    expect(await emptyListing.json()).toEqual({ path: DRIVE_TRASH_DIRECTORY, entries: [] })

    await upload('report.tar.gz', 'original')
    await deleteDriveEntry('report.tar.gz')
    await upload('report.tar.gz', 'second')
    await deleteDriveEntry('report.tar.gz')
    await json('/directory', { name: 'empty' })
    await json('/directory', { name: 'folder' })
    await json('/directory', { path: 'folder', name: 'nested' })
    await upload('inside.txt', 'contents', 'folder/nested')

    for (const path of ['empty', 'folder']) expect((await deleteDriveEntry(path)).status).toBe(200)

    expect(await readFile(join(trashPath(), 'report.tar.gz'), 'utf8')).toBe('original')
    expect(await readFile(join(trashPath(), 'report.tar (1).gz'), 'utf8')).toBe('second')
    expect(await readFile(join(trashPath(), 'folder', 'nested', 'inside.txt'), 'utf8')).toBe('contents')
    expect((await stat(join(trashPath(), 'empty'))).isDirectory()).toBe(true)
    expect((await (await get('', { path: DRIVE_TRASH_DIRECTORY })).json()).entries.map(entry => entry.name))
        .toEqual(['empty', 'folder', 'report.tar (1).gz', 'report.tar.gz'])
    expect((await (await get()).json()).entries.map(entry => entry.name)).toEqual([])
})

it('preserves the source when the reserved trash directory cannot be created', async () => {
    await get()
    await stopTrashCleanup()
    await rm(trashPath(), { recursive: true, force: true })
    await writeFile(join(root, DRIVE_TRASH_DIRECTORY), 'not a directory')
    await upload('preserve.txt', 'contents')

    const response = await deleteDriveEntry('preserve.txt')
    expect(response.status).toBe(500)
    expect(await readFile(join(root, 'preserve.txt'), 'utf8')).toBe('contents')
})

it('protects the reserved trash path and empties it without removing its folder', async () => {
    await get('', { path: DRIVE_TRASH_DIRECTORY })
    await writeFile(join(trashPath(), 'keep.txt'), 'contents')
    await upload('outside.txt', 'outside')

    expect((await deleteDriveEntry(DRIVE_TRASH_DIRECTORY)).status).toBe(400)
    expect((await deleteDriveEntry(`${DRIVE_TRASH_DIRECTORY}/keep.txt`)).status).toBe(400)
    expect((await json('/rename', { path: `${DRIVE_TRASH_DIRECTORY}/keep.txt`, name: 'renamed' }, 'PATCH')).status).toBe(400)
    expect((await json('/rename', { path: 'outside.txt', name: DRIVE_TRASH_DIRECTORY }, 'PATCH')).status).toBe(400)
    expect((await json('/directory', { name: DRIVE_TRASH_DIRECTORY })).status).toBe(400)
    expect((await upload('forbidden', 'data', DRIVE_TRASH_DIRECTORY)).status).toBe(400)
    expect((await upload(DRIVE_TRASH_DIRECTORY, 'data')).status).toBe(400)
    await mkdir(join(trashPath(), 'nested', 'folder'), { recursive: true })
    await writeFile(join(trashPath(), 'nested', 'folder', 'inside.txt'), 'nested contents')

    expect((await emptyDriveTrash()).status).toBe(200)
    expect(await readdir(trashPath())).toEqual([])
    expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('outside')
})

it('refuses to empty a trash tree containing an unsupported entry', async () => {
    await get('', { path: DRIVE_TRASH_DIRECTORY })
    await writeFile(join(directory, 'private'), 'secret')
    await writeFile(join(trashPath(), 'keep.txt'), 'contents')
    await symlink(join(directory, 'private'), join(trashPath(), 'link'))

    expect((await emptyDriveTrash()).status).toBe(403)
    expect(await readdir(trashPath())).toEqual(['keep.txt', 'link'])
    expect(await readFile(join(directory, 'private'), 'utf8')).toBe('secret')
})

it('expires entries from their recorded trash time and preserves missing or invalid timestamps', async () => {
    const savePath = await mkdtemp(join(tmpdir(), 'risu-drive-expiry-'))
    const trashRoot = join(savePath, 'drive', DRIVE_TRASH_DIRECTORY)
    const now = Date.now()
    const expiredAt = now - 3 * 24 * 60 * 60 * 1000 - 1000
    await mkdir(join(trashRoot, 'old-folder'), { recursive: true })
    await writeFile(join(trashRoot, 'expired.txt'), 'expired')
    await writeFile(join(trashRoot, 'old-folder', 'nested.txt'), 'expired folder')
    await writeFile(join(trashRoot, 'recent.txt'), 'keep despite old mtime')
    await writeFile(join(trashRoot, 'unknown.txt'), 'keep without a timestamp')
    await writeFile(join(savePath, 'outside.txt'), 'private')
    await symlink(join(savePath, 'outside.txt'), join(trashRoot, 'unsupported-link'))
    await utimes(join(trashRoot, 'expired.txt'), new Date(now + 24 * 60 * 60 * 1000), new Date(now + 24 * 60 * 60 * 1000))
    await utimes(join(trashRoot, 'recent.txt'), new Date(now - 5 * 24 * 60 * 60 * 1000), new Date(now - 5 * 24 * 60 * 60 * 1000))
    await writeFile(join(savePath, 'drive-trash.json'), JSON.stringify({
        'expired.txt': expiredAt,
        'old-folder': expiredAt,
        'recent.txt': now,
        'unknown.txt': 'invalid timestamp',
        'unsupported-link': expiredAt,
    }))

    const app = express()
    const stopCleanup = installDriveRoutes(app, {
        savePath,
        checkAuth: async () => true,
        checkDownloadAuth: async () => true,
        isCloudflareTunnelRequest: isRemoteTunnelRequest,
    }).stopTrashCleanup
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
        await vi.waitFor(async () => expect((await readdir(trashRoot)).sort())
            .toEqual(['recent.txt', 'unknown.txt', 'unsupported-link']))
        expect(await readFile(join(trashRoot, 'recent.txt'), 'utf8')).toBe('keep despite old mtime')
        expect(await readFile(join(trashRoot, 'unknown.txt'), 'utf8')).toBe('keep without a timestamp')
        expect(await readFile(join(savePath, 'outside.txt'), 'utf8')).toBe('private')
        expect(JSON.parse(await readFile(join(savePath, 'drive-trash.json'), 'utf8')))
            .toMatchObject({ 'recent.txt': now, 'unknown.txt': 'invalid timestamp', 'unsupported-link': expiredAt })
    } finally {
        await stopCleanup()
        errorLog.mockRestore()
        await rm(savePath, { recursive: true, force: true })
    }
})

it('expires entries after the server has been running for their retention period', async () => {
    const savePath = await mkdtemp(join(tmpdir(), 'risu-drive-live-expiry-'))
    const trashRoot = join(savePath, 'drive', DRIVE_TRASH_DIRECTORY)
    const expiresAt = Date.now() + 700
    const trashedAt = expiresAt - 3 * 24 * 60 * 60 * 1000
    await mkdir(trashRoot, { recursive: true })
    await writeFile(join(trashRoot, 'running.txt'), 'will expire')
    await writeFile(join(savePath, 'drive-trash.json'), JSON.stringify({ 'running.txt': trashedAt }))

    const stopCleanup = installDriveRoutes(express(), {
        savePath,
        checkAuth: async () => true,
        checkDownloadAuth: async () => true,
        isCloudflareTunnelRequest: isRemoteTunnelRequest,
    }).stopTrashCleanup
    try {
        expect(await readFile(join(trashRoot, 'running.txt'), 'utf8')).toBe('will expire')
        await vi.waitFor(async () => expect(await readdir(trashRoot)).toEqual([]), { timeout: 5000, interval: 20 })
    } finally {
        await stopCleanup()
        await rm(savePath, { recursive: true, force: true })
    }
})

it('refreshes expiry when the shared retention setting changes and normalizes its value', async () => {
    const savePath = await mkdtemp(join(tmpdir(), 'risu-drive-retention-setting-'))
    const trashRoot = join(savePath, 'drive', DRIVE_TRASH_DIRECTORY)
    const day = 24 * 60 * 60 * 1000
    const now = Date.now()
    let retentionDays: unknown = 3
    await mkdir(trashRoot, { recursive: true })
    await writeFile(join(trashRoot, 'two-days.txt'), 'expires after shortening')
    await writeFile(join(trashRoot, 'four-days.txt'), 'already expired')
    await writeFile(join(savePath, 'drive-trash.json'), JSON.stringify({
        'two-days.txt': now - 2 * day - 1000,
        'four-days.txt': now - 4 * day - 1000,
    }))

    const drive = installDriveRoutes(express(), {
        savePath,
        checkAuth: async () => true,
        checkDownloadAuth: async () => true,
        isCloudflareTunnelRequest: isRemoteTunnelRequest,
        getTrashRetentionDays: () => retentionDays,
    })
    try {
        await drive.refreshTrashRetention()
        expect(await readdir(trashRoot)).toEqual(['two-days.txt'])

        retentionDays = 1
        await drive.refreshTrashRetention()
        expect(await readdir(trashRoot)).toEqual([])

        await writeFile(join(trashRoot, 'disabled.txt'), 'kept while disabled')
        await writeFile(join(savePath, 'drive-trash.json'), JSON.stringify({
            'disabled.txt': Date.now() - 4 * day - 1000,
        }))
        retentionDays = 0
        await drive.refreshTrashRetention()
        expect(await readdir(trashRoot)).toEqual(['disabled.txt'])

        retentionDays = 3
        await drive.refreshTrashRetention()
        expect(await readdir(trashRoot)).toEqual([])

        await writeFile(join(trashRoot, 'normalized.txt'), 'fractional retention')
        await writeFile(join(savePath, 'drive-trash.json'), JSON.stringify({
            'normalized.txt': Date.now() - 2 * day,
        }))
        retentionDays = 1.9
        await drive.refreshTrashRetention()
        expect(await readdir(trashRoot)).toEqual([])
    } finally {
        await drive.stopTrashCleanup()
        await rm(savePath, { recursive: true, force: true })
    }
})

it('adds unique numbers before the extension without overwriting concurrent uploads', async () => {
    await upload('photo.png', 'original')
    const responses = await Promise.all(['first', 'second', 'third'].map(body => upload('photo.png', body, '', 'rename')))
    expect(responses.every(response => response.status === 201)).toBe(true)
    const names = await Promise.all(responses.map(async response => (await response.json()).entry.name))
    expect(names.sort()).toEqual(['photo (1).png', 'photo (2).png', 'photo (3).png'])
    expect(await readFile(join(root, 'photo.png'), 'utf8')).toBe('original')
    const contents = await Promise.all(names.map(name => readFile(join(root, name), 'utf8')))
    expect(contents.sort()).toEqual(['first', 'second', 'third'])
    await json('/directory', { name: 'folder' })
    expect((await (await upload('folder', 'file', '', 'rename')).json()).entry.name).toBe('folder (1)')
    await upload('.env')
    expect((await (await upload('.env', 'new', '', 'rename')).json()).entry.name).toBe('.env (1)')
    const longName = '가'.repeat(83) + '.txt'
    await upload(longName)
    const longCopy = await upload(longName, 'new', '', 'rename')
    expect(longCopy.status).toBe(201)
    const finalName = (await longCopy.json()).entry.name
    expect(Buffer.byteLength(finalName)).toBeLessThanOrEqual(255)
    expect(finalName.endsWith(' (1).txt')).toBe(true)
    expect((await upload('wrong-mode', 'data', '', 'unexpected')).status).toBe(400)
})

it('keeps the original intact while a replacement streams and after cancellation', async () => {
    await upload('report.txt', 'original')
    await vi.waitFor(async () => expect((await stat(trashPath())).isDirectory()).toBe(true))
    const beforeDrive = (await readdir(root)).sort()
    const req = request(`${base}/file?name=report.txt&conflict=overwrite`, {
        method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream', 'content-length': 1024 * 1024 },
    })
    req.on('error', () => {})
    try {
        req.write(Buffer.alloc(64 * 1024, 42))
        await vi.waitFor(async () => expect((await readdir(root)).some(name => !beforeDrive.includes(name))).toBe(true))
        expect(await readFile(join(root, 'report.txt'), 'utf8')).toBe('original')
        req.destroy()
        await vi.waitFor(async () => expect((await readdir(root)).sort()).toEqual(beforeDrive))
        expect(await readFile(join(root, 'report.txt'), 'utf8')).toBe('original')
    } finally {
        req.destroy()
    }
})

it('authenticates all operations before accessing storage', async () => {
    await vi.waitFor(async () => expect((await stat(trashPath())).isDirectory()).toBe(true))
    const beforeDrive = await readdir(root)
    const beforeSave = await readdir(directory)
    const operations = [
        ['', 'GET'], ['/metadata?path=x', 'GET'], ['/download?path=x', 'GET'],
        ['/directory', 'POST'], ['/rename', 'PATCH'], ['/entry', 'DELETE'], ['/file?name=x', 'PUT'],
        ['/trash', 'DELETE'],
    ]
    for (const [route, method] of operations) {
        const response = await fetch(base + route, { method })
        expect(response.status, route).toBe(401)
    }
    expect(await readdir(root)).toEqual(beforeDrive)
    expect(await readdir(directory)).toEqual(beforeSave)
})

it('rejects escaping paths and invalid names consistently for every operation', async () => {
    for (const path of ['../outside', '/outside', 'C:\\outside', 'folder/../../outside', 'folder//file', 'folder/./file', 'x\0y']) {
        const responses = await Promise.all([
            get('', { path }), get('/metadata', { path }), get('/download', { path }),
            json('/directory', { path, name: 'x' }), json('/rename', { path, name: 'x' }, 'PATCH'),
            json('/entry', { path }, 'DELETE'), upload('x', 'x', path),
        ])
        for (const response of responses) expect(response.status, path).toBe(400)
    }
    for (const name of ['..', '../escape', 'a/b', 'a\\b', 'NUL.txt', 'a:stream', 'trailing.', '.pocketrisu-upload-private']) {
        for (const response of await Promise.all([upload(name), json('/directory', { name })])) {
            expect(response.status, name).toBe(400)
        }
    }
    const invalidType = await json('/directory', { path: ['folder'], name: 'x' })
    expect(invalidType.status).toBe(400)
    expect((await json('/rename', { path: '', name: 'root' }, 'PATCH')).status).toBe(400)
    expect((await deleteDriveEntry('')).status).toBe(400)
})

it('hides links and refuses traversal through symlinks, directory links and hard links', async () => {
    await get()
    await writeFile(join(directory, 'private'), 'private')
    await mkdir(join(directory, 'outside'))
    await writeFile(join(directory, 'outside', 'secret'), 'secret')
    await symlink(join(directory, 'private'), join(root, 'link'))
    await symlink(join(directory, 'outside'), join(root, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir')
    await link(join(directory, 'private'), join(root, 'hard-link'))
    expect((await (await get()).json()).entries).toEqual([])
    for (const path of ['link', 'hard-link', 'linked-dir/secret']) {
        for (const response of await Promise.all([
            get('/metadata', { path }), get('/download', { path }), json('/rename', { path, name: 'renamed' }, 'PATCH'),
            json('/entry', { path }, 'DELETE'),
        ])) expect(response.status, path).toBe(403)
    }
    const folderWithLink = join(root, 'folder-with-link')
    await mkdir(folderWithLink)
    await symlink(join(directory, 'private'), join(folderWithLink, 'link'))
    const folderWithHardLink = join(root, 'folder-with-hard-link')
    await mkdir(folderWithHardLink)
    await link(join(directory, 'private'), join(folderWithHardLink, 'hard-link'))
    expect((await deleteDriveEntry('folder-with-link')).status).toBe(403)
    expect((await deleteDriveEntry('folder-with-hard-link')).status).toBe(403)
    expect(await readdir(folderWithLink)).toEqual(['link'])
    expect(await readdir(folderWithHardLink)).toEqual(['hard-link'])
    for (const response of await Promise.all([
        get('', { path: 'linked-dir' }), upload('new', 'data', 'linked-dir'),
        json('/directory', { path: 'linked-dir', name: 'new' }),
    ])) expect(response.status).toBe(403)
    expect(await readFile(join(directory, 'private'), 'utf8')).toBe('private')
    expect(await readdir(join(directory, 'outside'))).toEqual(['secret'])
})

it('refuses a symlink used as the drive root', async () => {
    await stopTrashCleanup()
    await rm(root, { recursive: true, force: true })
    const outside = join(directory, 'outside')
    await mkdir(outside)
    await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await get()).status).toBe(403)
    expect((await upload('escape')).status).toBe(403)
    expect((await deleteDriveEntry('escape')).status).toBe(403)
    expect(await readdir(outside)).toEqual([])
})

it('keeps in-progress uploads private and cleans up when a device disconnects', async () => {
    await vi.waitFor(async () => expect((await stat(trashPath())).isDirectory()).toBe(true))
    const beforeDrive = (await readdir(root)).sort()
    const req = request(`${base}/file?name=interrupted`, {
        method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream', 'content-length': 1024 * 1024 },
    })
    req.on('error', () => {})
    try {
        req.write(Buffer.alloc(64 * 1024, 42))
        await vi.waitFor(async () => {
            const temporary = (await readdir(root)).find(name => !beforeDrive.includes(name))
            expect(temporary).toBeDefined()
            expect((await stat(join(root, temporary!))).size).toBeGreaterThan(0)
        })
        expect((await (await get()).json()).entries).toEqual([])
        req.destroy()
        await vi.waitFor(async () => expect((await readdir(root)).sort()).toEqual(beforeDrive))
    } finally {
        req.destroy()
    }
    const unsupportedType = await fetch(base + '/file?name=wrong-type', {
        method: 'PUT', headers: { ...auth, 'content-type': 'text/plain' }, body: 'data',
    })
    expect(unsupportedType.status).toBe(415)
    expect((await readdir(root)).sort()).toEqual(beforeDrive)
})

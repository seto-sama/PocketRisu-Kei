import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeInlayAsset, decodeInlayAsset } from '../../../src/ts/storage/inlayTransport'
import { encodeBinaryMessage } from '../../../src/ts/network/binaryMessage'
import { MAX_GENERATION_BODY_BYTES } from '../../../src/ts/process/revenant/transport/protocol'
import { createDelta } from '../../../shared/guardedDelta.mjs'
import { pocketKeiVer } from '../../../src/ts/version'

const { decodeRisuSave } = createRequire(import.meta.url)('../utils.cjs') as {
    decodeRisuSave(data: Uint8Array): Promise<any>
}

describe('server route composition', () => {
    const characterId = 'route-character'
    const chatId = 'route-chat'
    const inlayBytes = Uint8Array.of(0, 255, 128, 13, 10)
    let child: ChildProcess
    let directory: string
    let base: string
    let headers: Record<string, string>
    let output = ''

    beforeAll(async () => {
        directory = mkdtempSync(join(tmpdir(), 'risu-routes-'))
        mkdirSync(join(directory, 'save'))
        mkdirSync(join(directory, 'dist'))
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: pocketKeiVer }))
        writeFileSync(join(directory, 'dist', 'index.html'), '<html><head></head><body>route test</body></html>')
        const entry = resolve('server/node/server.cjs')
        child = spawn(process.execPath, ['-e', `
            const http = require('node:http');
            const nativeFetch = globalThis.fetch;
            globalThis.fetch = (input, init) => String(input) === 'https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest'
                ? Promise.resolve(new Response(JSON.stringify({ tag_name: ${JSON.stringify(`kei-v${pocketKeiVer}`)} }), { status: 200 }))
                : nativeFetch(input, init);
            const listen = http.Server.prototype.listen;
            http.Server.prototype.listen = function (...args) {
                this.once('listening', () => process.send({ port: this.address().port }));
                return listen.apply(this, args);
            };
            require(${JSON.stringify(entry)});
        `], {
            cwd: directory,
            env: { ...process.env, PORT: '0', RISU_TUNNEL_DISABLED: 'true', SQLITE_TMPDIR: join(directory, 'save') },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        child.stdout!.on('data', data => { output += data })
        child.stderr!.on('data', data => { output += data })
        const port = await new Promise<number>((resolvePort, reject) => {
            child.once('message', (message: { port: number }) => resolvePort(message.port))
            child.once('error', reject)
            child.once('exit', code => reject(new Error(`Server exited (${code}): ${output}`)))
        })
        base = `http://127.0.0.1:${port}`
        const setup = await fetch(base + '/api/set_password', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: 'route-test-password' }),
        })
        expect(setup.status).toBe(200)
        const login = await fetch(base + '/api/login', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: 'route-test-password' }),
        })
        expect(login.status).toBe(200)
        headers = { 'risu-auth': (await login.json()).token, 'x-sync-client-id': 'route-test' }
        const initialized = await fetch(base + '/api/database', {
            method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ database: { characters: [{
                chaId: characterId,
                chats: [{ id: chatId, message: [
                    { chatId: 'route-message-1', role: 'user', data: 'hello' },
                    { chatId: 'route-message-2', role: 'char', data: 'answer' },
                ] }],
            }] }, expectedRevision: 0 }),
        })
        expect(initialized.status, await initialized.text()).toBe(200)
    }, 30_000)

    afterAll(async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
            await new Promise<void>(resolveExit => {
                child.once('exit', () => resolveExit())
                child.kill('SIGTERM')
            })
        }
        if (directory) rmSync(directory, { recursive: true, force: true })
    })

    const chatPath = () => `${base}/api/chat-content/${characterId}/0`
    const chatHeaders = () => ({ ...headers, 'x-chat-id': chatId })

    async function readChat() {
        const response = await fetch(chatPath(), { headers: chatHeaders() })
        expect(response.status).toBe(200)
        return decodeRisuSave(new Uint8Array(await response.arrayBuffer()))
    }

    const patchChat = (before: any, after: any) => fetch(chatPath(), {
        method: 'PATCH', headers: { ...chatHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ changes: createDelta(before, after) }),
    })

    async function writeInlay(id: string) {
        const response = await fetch(base + '/api/write', {
            method: 'POST', headers: {
                ...headers, 'file-path': Buffer.from(`inlay/${id}`).toString('hex'),
                'content-type': 'application/octet-stream',
            },
            body: encodeInlayAsset({ ext: 'png', name: '이미지', type: 'image', mime: 'image/png' }, inlayBytes),
        })
        expect(response.status, await response.text()).toBe(200)
    }

    it('serves feature routes, retains authentication and exposes the same live auth state', async () => {
        const page = await fetch(base)
        expect(await page.text()).toContain('globalThis.__NODE__ = true')
        for (const path of ['/api/active-devices', '/api/logs', '/api/request-logs', '/api/usage', '/api/backup/schedule', '/api/bookmarks', '/api/db/snapshots/limits', '/api/tunnel/status', '/api/update-check']) {
            const response = await fetch(base + path, { headers })
            expect(response.status, path + ': ' + await response.text()).toBe(200)
        }
        const unauthorized = await fetch(base + '/api/read', { headers: { 'file-path': Buffer.from('assets/test').toString('hex') } })
        expect(unauthorized.status).toBe(401)
        expect(await unauthorized.json()).toMatchObject({ code: 'AUTH_REQUIRED' })
        const session = await fetch(base + '/api/session', { method: 'POST', headers })
        expect(session.status).toBe(200)
        const restored = await fetch(base + '/api/test_auth', { headers: { cookie: session.headers.get('set-cookie')!.split(';')[0] } })
        expect((await restored.json()).status).toBe('success')
    })

    it('authenticates thought context queries and returns an empty result for unknown responses', async () => {
        const request = { method: 'POST', body: JSON.stringify({ responseIds: ['unknown'], adapterKind: 'google-gemini', model: 'gemini' }) }
        const unauthenticated = await fetch(base + '/api/provider-contexts/query', {
            ...request, headers: { 'content-type': 'application/json' },
        })
        expect(unauthenticated.status).toBe(401)
        const response = await fetch(base + '/api/provider-contexts/query', { ...request, headers: { ...headers, 'content-type': 'application/json' } })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ records: [] })
    })

    it('mounts the drive with server login and cookie downloads while keeping mutations JWT-only', async () => {
        const uploadUrl = base + '/api/drive/file?name=shared.bin'
        const upload = await fetch(uploadUrl, {
            method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: Uint8Array.of(0, 128, 255),
        })
        expect(upload.status).toBe(201)
        const listing = await fetch(base + '/api/drive', { headers })
        expect((await listing.json()).entries).toEqual([expect.objectContaining({ name: 'shared.bin', size: 3 })])
        const session = await fetch(base + '/api/session', { method: 'POST', headers })
        const cookie = session.headers.get('set-cookie')!.split(';')[0]
        const download = await fetch(base + '/api/drive/download?path=shared.bin', { headers: { cookie } })
        expect(download.status).toBe(200)
        expect(new Uint8Array(await download.arrayBuffer())).toEqual(Uint8Array.of(0, 128, 255))
        expect((await fetch(base + '/api/drive/download?path=shared.bin')).status).toBe(401)
        const cookieMutation = await fetch(base + '/api/drive/rename', {
            method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'shared.bin', name: 'changed.bin' }),
        })
        expect(cookieMutation.status).toBe(401)
    })

    it('clears request payloads separately from metadata', async () => {
        execFileSync(process.execPath, ['-e', `
            const logs = require(process.argv[1]);
            logs.addRequestLog({
                id: 'scoped-clear', timestamp: 100, date: 'test',
                url: 'https://provider.test/chat/completions',
                body: JSON.stringify({ model: 'gemini-test' }), header: '{}', response: 'answer',
                success: true, chatId: 'response-id',
            });
        `, resolve('server/node/logs/requestLogs.cjs')], { cwd: directory })

        const initial = await fetch(base + '/api/request-logs/scoped-clear', { headers })
        expect(initial.status).toBe(200)
        expect((await initial.json()).content).toMatchObject({
            model: 'gemini-test', response: 'answer', payloadAvailable: true,
        })

        const withoutScope = await fetch(base + '/api/request-logs', { method: 'DELETE', headers })
        expect(withoutScope.status).toBe(400)
        const payloads = await fetch(base + '/api/request-logs?scope=payload', { method: 'DELETE', headers })
        expect(payloads.status).toBe(200)
        const retained = await fetch(base + '/api/request-logs/scoped-clear', { headers })
        expect(retained.status).toBe(200)
        expect((await retained.json()).content).toMatchObject({
            id: 'scoped-clear', model: 'gemini-test', chatId: 'response-id',
            body: '', header: '', response: '', payloadAvailable: false,
        })
        const list = await fetch(base + '/api/request-logs', { headers })
        expect((await list.json()).content).toEqual([expect.objectContaining({ id: 'scoped-clear' })])

        const all = await fetch(base + '/api/request-logs?scope=all', { method: 'DELETE', headers })
        expect(all.status).toBe(200)
        const removed = await fetch(base + '/api/request-logs/scoped-clear', { headers })
        expect(removed.status).toBe(404)
        const empty = await fetch(base + '/api/request-logs', { headers })
        expect(await empty.json()).toMatchObject({ content: [], total: 0 })
    })

    it('authenticates and validates request script quota updates', async () => {
        const mebibyte = 1024 * 1024
        const defaultLimit = 256 * mebibyte
        const limitUrl = base + '/api/request-logs/limits'
        const initial = await fetch(base + '/api/request-logs', { headers })
        expect(initial.status).toBe(200)
        expect((await initial.json()).storage).toMatchObject({ maxBytes: defaultLimit })

        const unauthorized = await fetch(limitUrl, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ maxBytes: 2 * mebibyte }),
        })
        expect(unauthorized.status).toBe(401)
        const missingSyncClient = await fetch(limitUrl, {
            method: 'PUT', headers: { 'risu-auth': headers['risu-auth'], 'content-type': 'application/json' },
            body: JSON.stringify({ maxBytes: 2 * mebibyte }),
        })
        expect(missingSyncClient.status).toBe(400)

        for (const maxBytes of [mebibyte - 1, Number.MAX_SAFE_INTEGER + 1]) {
            const invalid = await fetch(limitUrl, {
                method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({ maxBytes }),
            })
            expect(invalid.status).toBe(400)
        }
        const afterInvalid = await fetch(base + '/api/request-logs', { headers })
        expect((await afterInvalid.json()).storage).toMatchObject({ maxBytes: defaultLimit })

        const changed = await fetch(limitUrl, {
            method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ maxBytes: 2 * mebibyte }),
        })
        expect(changed.status).toBe(200)
        expect(await changed.json()).toMatchObject({
            maxBytes: 2 * mebibyte,
            minBytes: mebibyte,
            currentBytes: expect.any(Number),
        })
        const persisted = await fetch(base + '/api/request-logs', { headers })
        expect((await persisted.json()).storage).toMatchObject({ maxBytes: 2 * mebibyte })

        const restored = await fetch(limitUrl, {
            method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ maxBytes: defaultLimit }),
        })
        expect(restored.status).toBe(200)
    })

    it('round-trips binary inlays through the mounted parser and filesystem', async () => {
        await writeInlay('route-test')
        const key = Buffer.from('inlay/route-test').toString('hex')
        const read = await fetch(base + '/api/read', { headers: { ...headers, 'file-path': key } })
        expect(read.status).toBe(200)
        const decoded = decodeInlayAsset(new Uint8Array(await read.arrayBuffer()))
        expect(decoded.bytes).toEqual(inlayBytes)
        expect(decoded.metadata).toMatchObject({ name: '이미지', type: 'image', mime: 'image/png' })
    })

    it('restores database and inlay data through the mounted backup routes', async () => {
        await writeInlay('backup-test')
        const chat = await readChat()
        const exported = await fetch(base + '/api/backup/export', { headers })
        expect(exported.status).toBe(200)
        const bytes = new Uint8Array(await exported.arrayBuffer())
        expect((await patchChat(chat, { ...chat, message: [] })).status).toBe(200)
        const restored = await fetch(base + '/api/backup/import', {
            method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes,
        })
        expect(restored.status, await restored.text()).toBe(200)
        expect((await readChat()).message).toEqual(chat.message)
        const read = await fetch(base + '/api/read', {
            headers: { ...headers, 'file-path': Buffer.from('inlay/backup-test').toString('hex') },
        })
        expect(read.status).toBe(200)
        expect(decodeInlayAsset(new Uint8Array(await read.arrayBuffer())).bytes).toEqual(inlayBytes)
    })

    it('serves backup and original asset downloads through the session cookie', async () => {
        await writeInlay('download-test')
        const session = await fetch(base + '/api/session', {
            method: 'POST', headers: { 'risu-auth': headers['risu-auth'] },
        })
        expect(session.status).toBe(200)
        const cookie = session.headers.get('set-cookie')!.split(';')[0]
        const name = 'risu-backup-1700000000000.bin'
        mkdirSync(join(directory, 'backups'), { recursive: true })
        writeFileSync(join(directory, 'backups', name), Uint8Array.of(0, 128, 255))
        const paths = ['/api/backup/export', `/api/backup/server/download/${name}`]
        for (const path of paths) {
            const response = await fetch(base + path, { headers: { cookie } })
            expect(response.status, path).toBe(200)
            expect(response.headers.get('content-disposition')).toContain('attachment')
            const bytes = new Uint8Array(await response.arrayBuffer())
            if (path.includes('/export')) {
                expect(bytes.byteLength).toBeGreaterThan(0)
            } else {
                expect(bytes).toEqual(Uint8Array.of(0, 128, 255))
            }
            for (const invalid of [{}, { cookie: 'risu-session=invalid' }]) {
                const refused = await fetch(base + path, { headers: invalid })
                expect(refused.status, path).toBe(401)
            }
        }
        const headerDownload = await fetch(base + paths[1], { headers: { ...headers, cookie: 'risu-session=invalid' } })
        expect(headerDownload.status).toBe(200)
        await headerDownload.arrayBuffer()

        const assetPath = `/api/asset/${Buffer.from('inlay/download-test').toString('hex')}`
        const assetDownload = await fetch(base + assetPath + '?download=1&filename=' + encodeURIComponent('한글.png'), { headers: { cookie } })
        expect(assetDownload.status).toBe(200)
        expect(assetDownload.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent('한글.png')}`)
        expect(assetDownload.headers.get('content-type')).toContain('image/png')
        expect(new Uint8Array(await assetDownload.arrayBuffer())).toEqual(inlayBytes)
        const fallbackDownload = await fetch(base + assetPath + '?download=1', { headers: { cookie } })
        expect(fallbackDownload.headers.get('content-disposition')).toContain('download-test.png')
        await fallbackDownload.arrayBuffer()
        const preview = await fetch(base + assetPath, { headers: { cookie } })
        expect(preview.headers.get('content-disposition')).toBeNull()
        await preview.arrayBuffer()
        const missingAsset = await fetch(base + `/api/asset/${Buffer.from('inlay/missing').toString('hex')}?download=1`, { headers: { cookie } })
        expect(missingAsset.status).toBe(404)
        expect(missingAsset.headers.get('content-disposition')).toBeNull()
        const mutation = await fetch(base + `/api/backup/server/${name}`, { method: 'DELETE', headers: { cookie } })
        expect(mutation.status).toBe(401)
    })

    it('returns stable codes for user-facing auth and backup errors', async () => {
        const login = await fetch(base + '/api/login', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: 'wrong-password' }),
        })
        expect(login.status).toBe(401)
        expect(await login.json()).toMatchObject({
            code: 'AUTH_INVALID_PASSWORD',
            error: 'Wrong password.',
        })

        const restore = await fetch(base + '/api/backup/server/restore', {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ filename: 'risu-backup-1.bin' }),
        })
        expect(restore.status).toBe(404)
        expect(await restore.json()).toMatchObject({
            code: 'BACKUP_NOT_FOUND',
            error: 'The backup file could not be found.',
        })
    })

    it.each([
        { name: 'JSON generation request', path: '/api/generation/jobs', type: 'application/json', body: JSON.stringify({ url: 'https://provider.test' }), status: 415 },
        { name: 'truncated generation envelope', path: '/api/generation/jobs', type: 'application/octet-stream', body: Uint8Array.of(0, 0, 0, 8), status: 400 },
        { name: 'oversized generation data', path: '/api/generation/jobs', type: 'application/octet-stream', body: encodeBinaryMessage({}, new Uint8Array(MAX_GENERATION_BODY_BYTES + 1)), status: 413 },
        { name: 'malformed inlay envelope', path: '/api/write', type: 'application/octet-stream', body: Uint8Array.of(0, 0, 0, 8), status: 400 },
    ])('keeps route-specific parsing: $name', async ({ path, type, body, status }) => {
        const response = await fetch(base + path, {
            method: 'POST', headers: { ...headers, 'content-type': type, 'file-path': Buffer.from('inlay/invalid').toString('hex') },
            body: body as BodyInit,
        })
        expect(response.status, await response.text()).toBe(status)
    })

    it('merges independent message changes and rejects overlapping edits over HTTP', async () => {
        const initial = await readChat()
        const chat = { ...initial, message: [{ chatId: 'old', role: 'user', data: 'original' }] }
        expect((await patchChat(initial, chat)).status).toBe(200)
        const reply = { chatId: 'reply', role: 'char', data: 'reply' }
        expect((await patchChat(chat, { ...chat, message: [...chat.message, reply] })).status).toBe(200)
        expect((await patchChat(chat, { ...chat, message: [] })).status).toBe(200)
        const canonical = await readChat()
        expect(canonical.message).toEqual([reply])
        expect((await patchChat(canonical, { ...canonical, message: [{ ...reply, data: 'first edit' }] })).status).toBe(200)
        const conflict = await patchChat(canonical, { ...canonical, message: [{ ...reply, data: 'second edit' }] })
        expect(conflict.status).toBe(409)
        expect(await conflict.json()).toMatchObject({ code: 'CHAT_CONTENT_CHANGED' })
    })

    it('merges independent database changes and rejects overlapping edits over HTTP', async () => {
        const projection = await (await fetch(base + '/api/database', { headers })).json()
        const db = projection.database
        const patchDb = (after: any) => fetch(base + '/api/database', {
            method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ changes: createDelta(db, after) }),
        })
        expect((await patchDb({ ...db, globalChatVariables: { toggleA: 'on' } })).status).toBe(200)
        expect((await patchDb({ ...db, globalChatVariables: { toggleB: 'on' } })).status).toBe(200)
        expect((await patchDb({ ...db, globalChatVariables: { toggleA: 'off' } })).status).toBe(409)
        const saved = await (await fetch(base + '/api/database', { headers })).json()
        expect(saved.database.globalChatVariables).toEqual({ toggleA: 'on', toggleB: 'on' })
    })
})

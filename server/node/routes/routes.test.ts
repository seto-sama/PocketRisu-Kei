import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeInlayAsset, decodeInlayAsset } from '../../../src/ts/storage/inlayTransport'
import { encodeBinaryMessage } from '../../../src/ts/network/binaryMessage'
import { MAX_GENERATION_BODY_BYTES } from '../../../src/ts/process/revenant/transport/protocol'

const { encodeRisuSaveLegacy } = createRequire(import.meta.url)('../utils.cjs') as {
    encodeRisuSaveLegacy(data: unknown): Uint8Array
}

describe('server route composition', () => {
    const characterId = 'route-character'
    const chatId = 'route-chat'
    let child: ChildProcess
    let directory: string
    let base: string
    let headers: Record<string, string>
    let output = ''

    beforeAll(async () => {
        directory = mkdtempSync(join(tmpdir(), 'risu-routes-'))
        mkdirSync(join(directory, 'save'))
        mkdirSync(join(directory, 'dist'))
        writeFileSync(join(directory, 'dist', 'index.html'), '<html><head></head><body>route test</body></html>')
        const entry = resolve('server/node/server.cjs')
        child = spawn(process.execPath, ['-e', `
            const http = require('node:http');
            const listen = http.Server.prototype.listen;
            http.Server.prototype.listen = function (...args) {
                this.once('listening', () => process.send({ port: this.address().port }));
                return listen.apply(this, args);
            };
            require(${JSON.stringify(entry)});
        `], {
            cwd: directory,
            env: { ...process.env, PORT: '0', RISU_UPDATE_CHECK: 'false', RISU_TUNNEL_DISABLED: 'true', SQLITE_TMPDIR: join(directory, 'save') },
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

    it('serves feature routes, retains authentication and exposes the same live auth state', async () => {
        const page = await fetch(base)
        expect(await page.text()).toContain('globalThis.__NODE__ = true')
        for (const path of ['/api/active-devices', '/api/logs', '/api/request-logs', '/api/usage', '/api/backup/schedule', '/api/bookmarks', '/api/db/snapshots/limits', '/api/tunnel/status', '/api/update-check']) {
            const response = await fetch(base + path, { headers })
            expect(response.status, path + ': ' + await response.text()).toBe(200)
        }
        const unauthorized = await fetch(base + '/api/read', { headers: { 'file-path': Buffer.from('assets/test').toString('hex') } })
        expect(unauthorized.status).toBe(400)
        const session = await fetch(base + '/api/session', { method: 'POST', headers })
        expect(session.status).toBe(200)
        const restored = await fetch(base + '/api/test_auth', { headers: { cookie: session.headers.get('set-cookie')!.split(';')[0] } })
        expect((await restored.json()).status).toBe('success')
    })

    it('round-trips binary inlays through the mounted parser and filesystem', async () => {
        const bytes = Uint8Array.of(0, 255, 128, 13, 10)
        const key = Buffer.from('inlay/route-test').toString('hex')
        const write = await fetch(base + '/api/write', {
            method: 'POST', headers: { ...headers, 'file-path': key, 'content-type': 'application/octet-stream' },
            body: encodeInlayAsset({ ext: 'png', name: '이미지', type: 'image', mime: 'image/png' }, bytes),
        })
        expect(write.status, await write.text()).toBe(200)
        const read = await fetch(base + '/api/read', { headers: { ...headers, 'file-path': key } })
        expect(read.status).toBe(200)
        const decoded = decodeInlayAsset(new Uint8Array(await read.arrayBuffer()))
        expect(decoded.bytes).toEqual(bytes)
        expect(decoded.metadata).toMatchObject({ name: '이미지', type: 'image', mime: 'image/png' })
    })

    it('keeps backup uploads streaming through the mounted routes', async () => {
        const initialized = await fetch(base + '/api/database', {
            method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ database: { characters: [{ chaId: characterId, chats: [] }] }, expectedRevision: 0 }),
        })
        expect(initialized.status, await initialized.text()).toBe(200)
        const exported = await fetch(base + '/api/backup/export', { headers })
        expect(exported.status).toBe(200)
        const bytes = new Uint8Array(await exported.arrayBuffer())
        const restored = await fetch(base + '/api/backup/import', {
            method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes,
        })
        expect(restored.status, await restored.text()).toBe(200)
        const read = await fetch(base + '/api/read', {
            headers: { ...headers, 'file-path': Buffer.from('inlay/route-test').toString('hex') },
        })
        expect(decodeInlayAsset(new Uint8Array(await read.arrayBuffer())).bytes).toEqual(Uint8Array.of(0, 255, 128, 13, 10))
    })

    it.each([
        { name: 'JSON generation request', path: '/api/generation/jobs', type: 'application/json', body: JSON.stringify({ url: 'https://provider.test' }), status: 415 },
        { name: 'truncated generation envelope', path: '/api/generation/jobs', type: 'application/octet-stream', body: Uint8Array.of(0, 0, 0, 8), status: 400 },
        { name: 'oversized generation data', path: '/api/generation/jobs', type: 'application/octet-stream', body: encodeBinaryMessage({}, new Uint8Array(MAX_GENERATION_BODY_BYTES + 1)), status: 413 },
        { name: 'malformed inlay envelope', path: '/api/write', type: 'application/octet-stream', body: Uint8Array.of(0, 0, 0, 8), status: 400 },
        { name: 'binary chat data', path: `/api/chat-content/${characterId}/0`, type: 'application/octet-stream', body: encodeRisuSaveLegacy({ id: chatId, message: [] }), status: 200, extraHeaders: { 'x-chat-id': chatId } },
    ])('keeps route-specific parsing: $name', async ({ path, type, body, status, extraHeaders }) => {
        const response = await fetch(base + path, {
            method: 'POST', headers: { ...headers, ...extraHeaders, 'content-type': type, 'file-path': Buffer.from('inlay/invalid').toString('hex') },
            body: body as BodyInit,
        })
        expect(response.status, await response.text()).toBe(status)
    })
})

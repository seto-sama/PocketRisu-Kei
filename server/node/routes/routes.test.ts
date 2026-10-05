import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeInlayAsset, decodeInlayAsset } from '../../../src/ts/storage/inlayTransport'
import { encodeBinaryMessage } from '../../../src/ts/network/binaryMessage'
import { MAX_GENERATION_BODY_BYTES } from '../../../src/ts/process/revenant/transport/protocol'
import { createDelta } from '../../../shared/guardedDelta.mjs'

const { decodeRisuSave } = createRequire(import.meta.url)('../utils.cjs') as {
    decodeRisuSave(data: Uint8Array): Promise<any>
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
            const nativeFetch = globalThis.fetch;
            globalThis.fetch = (input, init) => String(input) === 'https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest'
                ? Promise.resolve(new Response(JSON.stringify({ tag_name: 'kei-v2.1.6' }), { status: 200 }))
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
        expect(unauthorized.status).toBe(401)
        expect(await unauthorized.json()).toMatchObject({ code: 'AUTH_REQUIRED' })
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
            body: JSON.stringify({ database: { characters: [{
                chaId: characterId,
                chats: [{ id: chatId, message: [
                    { chatId: 'same', data: 'a' }, { chatId: 'same', data: 'b' }, { data: 'c' },
                ] }],
            }] }, expectedRevision: 0 }),
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

    it('assigns stable IDs to imported legacy messages before serving a delta baseline', async () => {
        const path = `${base}/api/chat-content/${characterId}/99`
        const chatHeaders = { ...headers, 'x-chat-id': chatId }
        const read = async () => {
            const response = await fetch(path, { headers: chatHeaders })
            expect(response.status).toBe(200)
            return decodeRisuSave(new Uint8Array(await response.arrayBuffer()))
        }
        const normalized = await read()
        const ids = normalized.message.map((message: any) => message.chatId)
        expect(ids.every((id: unknown) => typeof id === 'string' && id.length > 0)).toBe(true)
        expect(new Set(ids).size).toBe(3)
        expect(await read()).toEqual(normalized)
        const edited = { ...normalized, message: normalized.message.slice(1) }
        const patched = await fetch(path, {
            method: 'PATCH', headers: { ...chatHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ changes: createDelta(normalized, edited) }),
        })
        expect(patched.status, await patched.text()).toBe(200)
        expect((await read()).message).toEqual(edited.message)
    })

    it('merges independent chat and database changes over HTTP and rejects overlapping edits', async () => {
        const readChat = async () => {
            const response = await fetch(`${base}/api/chat-content/${characterId}/99`, {
                headers: { ...headers, 'x-chat-id': chatId },
            })
            expect(response.status).toBe(200)
            return decodeRisuSave(new Uint8Array(await response.arrayBuffer()))
        }
        const patchChat = (before: any, after: any) => fetch(`${base}/api/chat-content/${characterId}/99`, {
            method: 'PATCH', headers: { ...headers, 'x-chat-id': chatId, 'content-type': 'application/json' },
            body: JSON.stringify({ changes: createDelta(before, after) }),
        })
        const initial = await readChat()
        const chat = { ...initial, message: [{ chatId: 'old', role: 'user', data: 'original' }] }
        expect((await patchChat(initial, chat)).status).toBe(200)
        const image = { chatId: 'image', role: 'char', kind: 'imageGeneration', data: 'image result' }
        expect((await patchChat(chat, { ...chat, message: [...chat.message, image] })).status).toBe(200)
        expect((await patchChat(chat, { ...chat, message: [] })).status).toBe(200)
        const canonical = await readChat()
        expect(canonical.message).toEqual([image])
        expect((await patchChat(canonical, { ...canonical, message: [{ ...image, data: 'first edit' }] })).status).toBe(200)
        const conflict = await patchChat(canonical, { ...canonical, message: [{ ...image, data: 'second edit' }] })
        expect(conflict.status).toBe(409)
        expect(await conflict.json()).toMatchObject({ code: 'CHAT_CONTENT_CHANGED' })

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

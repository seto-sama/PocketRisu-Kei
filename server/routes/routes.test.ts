import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { encode, decode } from 'msgpackr'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeInlayAsset, decodeInlayAsset } from '../../src/ts/storage/inlayTransport'
import { encodeBinaryMessage } from '../../src/ts/network/binaryMessage'
import { MAX_GENERATION_BODY_BYTES } from '../../src/ts/process/revenant/transport/protocol'
import { createDelta } from '../../shared/guardedDelta.mjs'
import { PROXY_PATH, getRealmProxyUrl } from '../../shared/proxy.mjs'
import { pocketKeiVer } from '../../src/ts/version'
import { decodeBackup } from '../../test/compat/helpers/decode'
import { openDatabase } from '../sqlite.cjs'
import appDataStorePkg from '../appDataStore.cjs'

const { decodeRisuSave } = createRequire(import.meta.url)('../utils/risuSave.cjs') as {
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
        const entry = resolve('server/server.cjs')
        child = spawn(process.execPath, ['-e', `
            const http = require('node:http');
            const nativeFetch = globalThis.fetch;
            globalThis.fetch = (input, init) => {
                if (String(input) === 'https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest') {
                    return Promise.resolve(new Response(JSON.stringify({ tag_name: ${JSON.stringify(`kei-v${pocketKeiVer}`)} }), { status: 200 }));
                }
                if (String(input) === 'https://sv.risuai.xyz/proxy-test') {
                    return Promise.resolve(new Response('realm-proxy'.repeat(256), {
                        headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=60' },
                    }));
                }
                return nativeFetch(input, init);
            };
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
            method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' },
            body: encode({ database: {
                characters: [{
                    chaId: characterId,
                    chats: [{ id: chatId, message: [
                        { chatId: 'route-message-1', role: 'user', data: 'hello' },
                        { chatId: 'route-message-2', role: 'char', data: 'answer' },
                    ] }],
                }],
                pluginCustomStorage: {
                    'transport-test/json-string': '{ "id": 9007199254740993, "prompt": "keep this JSON text" }\n',
                    'transport-test/scalar': 17,
                    'transport-test/object': { enabled: true, values: ['한글', 3] },
                },
            }, expectedRevision: 0 }),
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
        const pageHtml = await page.text()
        expect(pageHtml).toContain('globalThis.__NODE__ = true')
        expect(pageHtml).toContain('globalThis.__PRIVACY_GUARD__ = false')
        expect(page.headers.get('cache-control')).toContain('no-store')
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

    it('mounts anonymous Realm paths without compressing proxied responses and keeps general requests authenticated', async () => {
        const response = await fetch(base + getRealmProxyUrl('/proxy-test'), {
            headers: { 'accept-encoding': 'gzip' },
        })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-encoding')).toBeNull()
        expect(response.headers.get('cache-control')).toBe('public, max-age=60')
        expect(await response.text()).toBe('realm-proxy'.repeat(256))
        expect((await fetch(base + PROXY_PATH)).status).toBe(401)
    })

    it('round-trips native preset files through the mounted authenticated routes', async () => {
        const value = { name: '서버 프리셋', mainPrompt: 'Keep this prompt.' }
        const options = { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' } }
        const unauthorized = await fetch(base + '/api/file-formats/preset/encode', {
            ...options, headers: { 'content-type': 'application/octet-stream' }, body: encode(value),
        })
        expect(unauthorized.status).toBe(401)
        const encoded = await fetch(base + '/api/file-formats/preset/encode', { ...options, body: encode(value) })
        expect(encoded.status).toBe(200)
        const decoded = await fetch(base + '/api/file-formats/preset/decode', {
            ...options, body: new Uint8Array(await encoded.arrayBuffer()),
        })
        expect(decoded.status).toBe(200)
        expect(decode(new Uint8Array(await decoded.arrayBuffer()))).toEqual(value)
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

        const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=', 'base64')
        expect((await fetch(base + '/api/drive/file?name=portrait.png', {
            method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: image,
        })).status).toBe(201)
        const thumbnail = await fetch(base + '/api/drive/thumbnail?path=portrait.png', { headers: { cookie } })
        expect(thumbnail.status).toBe(200)
        expect(thumbnail.headers.get('content-type')).toContain('image/webp')
        expect(Buffer.from(await thumbnail.arrayBuffer()).subarray(8, 12).toString()).toBe('WEBP')
        // Character JPEGs append a charx archive after the image data.
        const characterJpeg = Buffer.concat([
            Buffer.from('/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APP6/9k=', 'base64'),
            Buffer.from('504b0506000000000000000000000000000000000000', 'hex'),
        ])
        await fetch(base + '/api/drive/file?name=character.jpg', {
            method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: characterJpeg,
        })
        expect((await fetch(base + '/api/drive/thumbnail?path=character.jpg', { headers: { cookie } })).status).toBe(200)
        await fetch(base + '/api/drive/file?name=disguised.png', {
            method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' },
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        })
        expect((await fetch(base + '/api/drive/thumbnail?path=disguised.png', { headers: { cookie } })).status).toBe(204)
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
        `, resolve('server/logs/requestLogs.cjs')], { cwd: directory })

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

    it('exports the numeric preset index and restores it as the canonical preset ID', async () => {
        const initial = (await (await fetch(base + '/api/database', { headers })).json()).database
        const withPresets = {
            ...initial,
            botPresets: [{ id: 'route-preset-a', name: 'A' }, { id: 'route-preset-b', name: 'B' }],
            activePromptPresetId: 'route-preset-b',
        }
        const save = async (database: any) => fetch(base + '/api/database', {
            method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ changes: createDelta(initial, database) }),
        })

        expect((await save(withPresets)).status).toBe(200)
        const exported = await fetch(base + '/api/backup/export', { headers })
        expect(exported.status).toBe(200)
        const backup = Buffer.from(await exported.arrayBuffer())
        const databaseEntry = decodeBackup(backup).find(entry => entry.name === 'database.risudat')!
        const portable = await decodeRisuSave(databaseEntry.data)
        expect(portable.botPresetsId).toBe(1)
        expect(portable).not.toHaveProperty('activePromptPresetId')

        const changed = (await (await fetch(base + '/api/database', { headers })).json()).database
        expect((await fetch(base + '/api/database', {
            method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ changes: createDelta(changed, {
                ...changed, activePromptPresetId: 'route-preset-a',
            }) }),
        })).status).toBe(200)

        const restored = await fetch(base + '/api/backup/import', {
            method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: backup,
        })
        expect(restored.status, await restored.text()).toBe(200)
        const installed = (await (await fetch(base + '/api/database', { headers })).json()).database
        expect(installed.activePromptPresetId).toBe('route-preset-b')
        expect(installed).not.toHaveProperty('botPresetsId')
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

    it('checkpoints and prepares a compressed snapshot with progress', async () => {
        await writeInlay('backup-size-test')
        const before = (await (await fetch(base + '/api/database', { headers })).json()).database
        const globalNote = 'Latest committed value for export'
        const saved = await fetch(base + '/api/database', {
            method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ changes: createDelta(before, { ...before, globalNote }) }),
        })
        expect(saved.status).toBe(200)
        const prepared = await fetch(base + '/api/backup/export/prepare', { method: 'POST', headers })
        expect(prepared.status, await prepared.clone().text()).toBe(200)
        expect(prepared.headers.get('content-type')).toContain('application/x-ndjson')
        expect(prepared.headers.get('cache-control')).toContain('no-transform')
        const events = (await prepared.text()).trim().split('\n').map(line => JSON.parse(line))
        expect(events[0]).toMatchObject({ type: 'progress', stage: 'saving' })
        const compression = events.filter(event => event.stage === 'compressing')
        expect(compression[0].bytes).toBe(0)
        expect(compression.at(-1).bytes).toBe(compression.at(-1).totalBytes)
        expect(events.at(-2)).toMatchObject({ type: 'progress', stage: 'ready' })
        expect(events.at(-1).type).toBe('done')
        const url = events.at(-1).url

        const copyPath = join(directory, 'checkpointed.db')
        copyFileSync(join(directory, 'save/risuai.db'), copyPath)
        const checkpointed = openDatabase(copyPath)
        try {
            const store = appDataStorePkg.createAppDataStore(checkpointed)
            expect(store.exportProjection({ includeMessages: false }).globalNote).toBe(globalNote)
        } finally {
            checkpointed.close()
        }

        const current = (await (await fetch(base + '/api/database', { headers })).json()).database
        const updated = await fetch(base + '/api/database', {
            method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ changes: createDelta(current, { ...current, globalNote: 'Changed after preparation' }) }),
        })
        expect(updated.status).toBe(200)
        const exported = await fetch(base + url, { headers })
        expect(exported.status).toBe(200)
        const backup = Buffer.from(await exported.arrayBuffer())
        expect(compression.at(-1).backupBytes).toBe(backup.length)
        expect(events.at(-2).totalBytes).toBe(backup.length)
        const entry = decodeBackup(backup)
            .find(entry => entry.name === 'database.risudat')!
        expect((await decodeRisuSave(entry.data)).globalNote).toBe(globalNote)
        expect((await fetch(base + url, { headers })).status).toBe(404)
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

    it('uses MessagePack for database reads and requests while keeping backups compatible', async () => {
        const binaryHeaders = { ...headers, accept: 'application/octet-stream' }
        const readBinaryProjection = async (extraHeaders: Record<string, string> = {}) => {
            const response = await fetch(base + '/api/database', {
                headers: { ...binaryHeaders, ...extraHeaders },
            })
            expect(response.status, await response.clone().text()).toBe(200)
            expect(response.headers.get('content-type')).toContain('application/octet-stream')
            return decode(new Uint8Array(await response.arrayBuffer())) as any
        }

        const initial = await readBinaryProjection()
        expect(initial.database.pluginCustomStorage).toEqual({
            'transport-test/json-string': '{ "id": 9007199254740993, "prompt": "keep this JSON text" }\n',
            'transport-test/scalar': 17,
            'transport-test/object': { enabled: true, values: ['한글', 3] },
        })

        const masked = await readBinaryProjection({ 'x-risu-plugin-storage-exclusion': 'all' })
        expect(masked.database.pluginCustomStorage).toEqual({})

        const patchDatabase = (baseDatabase: any, afterDatabase: any, maskedWrite = false) => fetch(base + '/api/database', {
            method: 'PATCH',
            headers: {
                ...headers,
                'content-type': 'application/octet-stream',
                ...(maskedWrite ? { 'x-risu-plugin-storage-exclusion': 'all' } : {}),
            },
            body: encode({ changes: createDelta(baseDatabase, afterDatabase) }),
        })

        const firstChange = await patchDatabase(
            masked.database,
            {
                ...masked.database,
                globalChatVariables: {
                    ...(masked.database.globalChatVariables ?? {}),
                    binaryTransportFirst: 'first',
                },
            },
            true,
        )
        expect(firstChange.status, await firstChange.clone().text()).toBe(200)
        expect(await firstChange.json()).toMatchObject({ success: true })

        const independentChange = await patchDatabase(
            masked.database,
            {
                ...masked.database,
                globalChatVariables: {
                    ...(masked.database.globalChatVariables ?? {}),
                    binaryTransportSecond: 'independent',
                },
            },
            true,
        )
        expect(independentChange.status, await independentChange.clone().text()).toBe(200)
        expect(await independentChange.json()).toMatchObject({ success: true })

        const overlappingChange = await patchDatabase(
            masked.database,
            {
                ...masked.database,
                globalChatVariables: {
                    ...(masked.database.globalChatVariables ?? {}),
                    binaryTransportFirst: 'conflicting',
                },
            },
            true,
        )
        expect(overlappingChange.status).toBe(409)
        expect(await overlappingChange.json()).toMatchObject({
            conflicts: [['globalChatVariables', 'binaryTransportFirst']],
        })

        const pluginCustomStorage = {
            ...initial.database.pluginCustomStorage,
            'transport-test/json-string': '{ "id": 9007199254740993, "updated": true }\n',
            'transport-test/scalar': 0,
            'transport-test/boolean': false,
        }
        const pluginWrite = await patchDatabase(initial.database, { ...initial.database, pluginCustomStorage })
        expect(pluginWrite.status, await pluginWrite.clone().text()).toBe(200)

        const current = await readBinaryProjection()
        expect(current.database).toMatchObject({
            globalChatVariables: {
                binaryTransportFirst: 'first',
                binaryTransportSecond: 'independent',
            },
            pluginCustomStorage,
        })

        const exported = await fetch(base + '/api/backup/export', { headers })
        expect(exported.status, await exported.clone().text()).toBe(200)
        const backup = Buffer.from(await exported.arrayBuffer())
        const databaseEntry = decodeBackup(backup).find(entry => entry.name === 'database.risudat')!
        const portable = await decodeRisuSave(databaseEntry.data)
        expect(portable.pluginCustomStorage).toEqual(pluginCustomStorage)
    })

    it('authenticates binary database requests and rejects malformed MessagePack without writing', async () => {
        const before = await (await fetch(base + '/api/database', { headers })).json()
        const options = { method: 'PATCH', body: Uint8Array.of(0xc1) }
        const unauthorized = await fetch(base + '/api/database', {
            ...options, headers: { 'content-type': 'application/octet-stream' },
        })
        expect(unauthorized.status).toBe(401)
        const malformed = await fetch(base + '/api/database', {
            ...options, headers: { ...headers, 'content-type': 'application/octet-stream' },
        })
        expect(malformed.status).toBe(400)
        const after = await (await fetch(base + '/api/database', { headers })).json()
        expect(after.revision).toBe(before.revision)
        expect(after.database).toEqual(before.database)
    })

    it('persists plugin namespaces independently and authenticates binary storage operations', async () => {
        const call = async (namespace: string, request: unknown) => {
            const response = await fetch(`${base}/api/plugin-storage/${namespace}`, {
                method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' },
                body: encode(request),
            })
            expect(response.status, await response.clone().text()).toBe(200)
            return decode(new Uint8Array(await response.arrayBuffer()))
        }
        const before = await (await fetch(base + '/api/database', { headers })).json()
        for (const [namespace, value] of [['localStorage', 'string'], ['localForage', 'binary']]) {
            await call(namespace, { op: 'set', key: 'shared', value: Buffer.from(value), owner: namespace })
            expect((await call(namespace, { op: 'get', key: 'shared' })).value).toEqual(Uint8Array.from(Buffer.from(value)))
        }
        await call('localStorage', { op: 'import', entries: [{ key: 'shared', value: Buffer.from('old browser value') }] })
        expect((await call('localStorage', { op: 'get', key: 'shared' })).value).toEqual(Uint8Array.from(Buffer.from('string')))
        expect(await call('localStorage', { op: 'list' })).toEqual({ entries: [{ key: 'shared', owner: 'localStorage' }] })
        await call('localStorage', { op: 'clear' })
        expect(await call('localStorage', { op: 'get', key: 'shared' })).toEqual({ value: null })
        expect((await call('localForage', { op: 'get', key: 'shared' })).value).toEqual(Uint8Array.from(Buffer.from('binary')))
        await call('localForage', { op: 'remove', key: 'shared' })

        const unauthorized = await fetch(base + '/api/plugin-storage/localStorage', {
            method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: encode({ op: 'clear' }),
        })
        expect(unauthorized.status).toBe(401)
        for (const [namespace, request] of [
            ['includedInSave', { op: 'clear' }],
            ['localStorage', { op: 'set', key: 'invalid', value: 'requires bytes' }],
        ] as const) {
            const invalid = await fetch(`${base}/api/plugin-storage/${namespace}`, {
                method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: encode(request),
            })
            expect(invalid.status).toBe(400)
        }
        const after = await (await fetch(base + '/api/database', { headers })).json()
        expect(after.revision).toBe(before.revision)
        expect(after.database).toEqual(before.database)
    })

    // Runs last: it moves the route character into a hidden folder.
    it('privacy guard hides folders, their inlays, and asks for the password per session', async () => {
        const password = 'route-test-password'
        const json = { ...headers, 'content-type': 'application/json' }
        const { database } = await (await fetch(base + '/api/database', { headers })).json()
        const hiddenOrder = { ...database, characterOrder: [{ id: 'guard-folder', name: 'Guard', color: '', localOnly: true, data: [characterId] }] }
        expect((await fetch(base + '/api/database', {
            method: 'PATCH', headers: json, body: JSON.stringify({ changes: createDelta(database, hiddenOrder) }),
        })).status).toBe(200)
        await writeInlay('guard-inlay')
        expect((await fetch(base + '/api/write', {
            method: 'POST', headers: {
                ...headers, 'file-path': Buffer.from('inlay_meta/guard-inlay').toString('hex'),
                'content-type': 'application/octet-stream',
            },
            body: JSON.stringify({ createdAt: 1, updatedAt: 1, charId: characterId }),
        })).status).toBe(200)
        const session = await fetch(base + '/api/session', { method: 'POST', headers })
        const cookie = session.headers.get('set-cookie')!.split(';')[0]
        const listInlays = async () => (await (await fetch(base + '/api/list', { headers: { ...headers, 'key-prefix': 'inlay/' } })).json()).content
        const visibleCharacters = async () => (await (await fetch(base + '/api/database', { headers })).json()).database.characters.map((char: any) => char.chaId)
        const cookieLogin = async () => (await (await fetch(base + '/api/test_auth', { headers: { cookie } })).json()).status
        const withPassword = (path: string, value: string) => fetch(base + path, {
            method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ password: value }),
        })
        expect(await listInlays()).toContain('inlay/guard-inlay')

        expect((await fetch(base + '/api/privacy-guard/enable', { method: 'POST', headers })).status).toBe(200)
        expect(await (await fetch(base)).text()).toContain('globalThis.__PRIVACY_GUARD__ = true')
        expect(await visibleCharacters()).toEqual([])
        expect(await listInlays()).not.toContain('inlay/guard-inlay')
        expect(await cookieLogin()).toBe('incorrect')

        expect((await withPassword('/api/privacy-guard/disable', 'wrong')).status).toBe(401)
        expect((await withPassword('/api/privacy-guard/disable', password)).status).toBe(200)
        expect(await visibleCharacters()).toEqual([characterId])
        expect(await listInlays()).toContain('inlay/guard-inlay')
        expect(await cookieLogin()).toBe('success')
    })
})

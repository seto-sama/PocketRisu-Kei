import { PROXY_PATH } from '../shared/proxy.mjs'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const express = require('express') as typeof import('express')
const { installAuthenticatedBodyParsing } = require('./requestBody.cjs') as {
    installAuthenticatedBodyParsing(app: import('express').Express, options: { checkAuth: Function }): void
}
const { installProxyRoutes } = require('./routes/proxy.cjs')
const { installAuthRoutes } = require('./routes/auth.cjs') as { installAuthRoutes(app: any, options: any): void }
const { createAuthService } = require('./auth.cjs')
const { createPrivacyGuard } = require('./privacyGuard.cjs')

type Fixture = {
    base: string
    close(): Promise<void>
}

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
    const directory = mkdtempSync(join(tmpdir(), 'risu-request-body-'))
    const auth = createAuthService({ savePath: directory })

    const app = express()
    installAuthRoutes(app, {
        auth,
        syncClientDevices: new Map(),
        privacyGuard: createPrivacyGuard({ savePath: directory }),
        broadcastPrivacyGuardChanged: () => {},
    })
    installAuthenticatedBodyParsing(app, { checkAuth: auth.checkDownloadAuth })
    app.post('/api/body-check', (req: any, res: any) => res.json({ body: req.body ?? null }))
    installProxyRoutes(app, { checkAuth: auth.checkAuth })

    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')
    const base = `http://127.0.0.1:${address.port}`
    const fixture: Fixture = {
        base,
        close: async () => {
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
            rmSync(directory, { recursive: true, force: true })
        },
    }
    fixtures.push(fixture)
    return fixture
}

afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})

async function login(fixture: Fixture): Promise<Record<string, string>> {
    const options = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'chosen-password' }),
    }
    expect((await fetch(`${fixture.base}/api/set_password`, options)).status).toBe(200)
    const response = await fetch(`${fixture.base}/api/login`, options)
    expect(response.status).toBe(200)
    const { token } = await response.json()
    return { 'risu-auth': token }
}

describe('authenticated request body parsing', () => {
    it('rejects unauthenticated malformed and compressed JSON before parsing', async () => {
        const fixture = await startFixture()
        const malformed = await fetch(`${fixture.base}/api/body-check`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
        })
        expect(malformed.status).toBe(401)

        const { gzipSync } = await import('node:zlib')
        const compressed = await fetch(`${fixture.base}/api/body-check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
            body: gzipSync(Buffer.from('{broken')),
        })
        expect(compressed.status).toBe(401)
    })

    it('rejects incomplete unauthenticated binary and form requests before parsing', async () => {
        const fixture = await startFixture()
        for (const contentType of ['application/octet-stream', 'application/x-www-form-urlencoded']) {
            for (const framing of ['chunked', 'declared-length'] as const) {
                const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
                    const headers = framing === 'chunked'
                        ? { 'content-type': contentType, 'transfer-encoding': 'chunked' }
                        : { 'content-type': contentType, 'content-length': '4096' }
                    const request = httpRequest(fixture.base + PROXY_PATH, { method: 'POST', headers })
                    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${framing} ${contentType} auth response`)), 2_000)
                    request.once('response', response => {
                        clearTimeout(timer)
                        const chunks: Buffer[] = []
                        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
                        response.once('end', () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString() }))
                    })
                    request.once('error', error => { clearTimeout(timer); reject(error) })
                    request.flushHeaders()
                    if (framing === 'chunked') request.write('partial')
                })
                expect(response.status).toBe(401)
                expect(JSON.parse(response.body)).toMatchObject({ code: 'AUTH_REQUIRED' })
            }
        }
    })

    it('parses authorized JSON and text and accepts a session cookie', async () => {
        const fixture = await startFixture()
        const send = (path: string, contentType: string, body: BodyInit, headers: Record<string, string> = {}) => fetch(fixture.base + path, {
            method: 'POST', headers: { ...headers, 'content-type': contentType }, body,
        })
        const authorized = await login(fixture)

        const json = await send('/api/body-check', 'application/json', JSON.stringify({ value: 7 }), authorized)
        expect(await json.json()).toEqual({ body: { value: 7 } })
        const text = await send('/api/body-check', 'text/plain', 'plain body', authorized)
        expect(await text.json()).toEqual({ body: 'plain body' })
        const sessionResponse = await fetch(`${fixture.base}/api/session`, { method: 'POST', headers: authorized })
        expect(sessionResponse.status).toBe(200)
        const session = await send('/api/body-check', 'application/json', JSON.stringify({ via: 'session' }), {
            cookie: sessionResponse.headers.get('set-cookie')!.split(';')[0],
        })
        expect(await session.json()).toEqual({ body: { via: 'session' } })
    })

    it('keeps auth-route limits local and checks set-password state before parsing', async () => {
        const fixture = await startFixture()
        const oversized = JSON.stringify({ password: 'x'.repeat(20_000) })
        const postJson = (path: string, body: string) => fetch(fixture.base + path, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body,
        })

        expect((await postJson('/api/login', oversized)).status).toBe(413)
        expect((await postJson('/api/crypto', JSON.stringify({ data: 'x'.repeat(20_000) }))).status).toBe(413)
        expect((await postJson('/api/set_password', oversized)).status).toBe(413)
        expect((await postJson('/api/set_password', JSON.stringify({ password: 'chosen-password' }))).status).toBe(200)
        expect((await postJson('/api/login', JSON.stringify({ password: 'chosen-password' }))).status).toBe(200)
        expect((await postJson('/api/set_password', '{malformed')).status).toBe(409)
    })

    it('refreshes an expired token into one accepted by protected routes', async () => {
        const fixture = await startFixture()
        vi.useFakeTimers({ toFake: ['Date'] })
        const authorized = await login(fixture)
        vi.setSystemTime(Date.now() + 6 * 60 * 1000)
        const sendBody = (headers: Record<string, string>) => fetch(`${fixture.base}/api/body-check`, {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
        })
        expect((await sendBody(authorized)).status).toBe(401)
        const response = await fetch(fixture.base + '/api/token/refresh', {
            method: 'POST', headers: authorized,
        })
        expect(response.status).toBe(200)
        const { token } = await response.json()
        expect((await sendBody({ 'risu-auth': token })).status).toBe(200)
    })
})

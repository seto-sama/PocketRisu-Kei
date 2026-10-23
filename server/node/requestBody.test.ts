import { PROXY_PATH } from '../../shared/proxy.mjs'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const express = require('express') as typeof import('express')
const { installAuthenticatedBodyParsing } = require('./requestBody.cjs') as {
    installAuthenticatedBodyParsing(app: import('express').Express, options: { checkAuth: Function }): void
}
const { installProxyRoutes } = require('./routes/proxy.cjs')
const { installAuthRoutes } = require('./routes/auth.cjs') as { installAuthRoutes(app: any, options: any): void }

type Fixture = {
    base: string
    authCalls: Array<{ token: string | undefined; options: Record<string, unknown> }>
    close(): Promise<void>
}

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
    const directory = mkdtempSync(join(tmpdir(), 'risu-request-body-'))
    const authCalls: Fixture['authCalls'] = []
    const authState = { password: '' }
    const sessions = new Map<string, number>()
    const loginBlockedUntil = new Map<string, number>()
    const checkAuth = async (req: any, res: any, _returnOnlyStatus = false, options: Record<string, unknown> = {}) => {
        const token = req.get('risu-auth') as string | undefined
        authCalls.push({ token, options })
        const sessionCookie = String(req.get('cookie') || '').split(';').some((part: string) => part.trim() === 'risu-session=session-equivalent')
        if (token === 'valid-token' || sessionCookie || (token === 'expired-token' && options.allowExpired === true)) return true
        res.status(401).json({ code: 'AUTH_REQUIRED' })
        return false
    }

    const app = express()
    installAuthRoutes(app, {
        SESSION_FILE: join(directory, 'sessions.json'),
        sessions,
        loginBlockedUntil,
        LOGIN_FAILURE_WINDOW_MS: 60_000,
        jwtSecret: 'request-body-test-secret',
        authState,
        checkAuth,
        parseSessionCookie: () => undefined,
        sessionExpiresAt: (session: number | undefined) => session ?? 0,
        getSyncClientIdFromRequest: () => undefined,
        syncClientDevices: new Map(),
        passwordPath: join(directory, 'password'),
    })
    installAuthenticatedBodyParsing(app, { checkAuth })
    app.post('/api/body-check', (req: any, res: any) => res.json({ body: req.body ?? null }))
    installProxyRoutes(app, { checkAuth })

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
        authCalls,
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
    await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})

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
        expect(fixture.authCalls).toHaveLength(2)
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
        const authorized = { 'risu-auth': 'valid-token' }

        const json = await send('/api/body-check', 'application/json', JSON.stringify({ value: 7 }), authorized)
        expect(await json.json()).toEqual({ body: { value: 7 } })
        const text = await send('/api/body-check', 'text/plain', 'plain body', authorized)
        expect(await text.json()).toEqual({ body: 'plain body' })
        const session = await send('/api/body-check', 'application/json', JSON.stringify({ via: 'session' }), {
            cookie: 'risu-session=session-equivalent',
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

    it('allows the refresh route to validate an expired token with its route-specific option', async () => {
        const fixture = await startFixture()
        const response = await fetch(fixture.base + '/api/token/refresh', {
            method: 'POST', headers: { 'risu-auth': 'expired-token' },
        })
        expect(response.status).toBe(200)
        expect(fixture.authCalls).toContainEqual({ token: 'expired-token', options: { allowExpired: true } })
    })
})

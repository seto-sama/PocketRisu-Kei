import express from 'express'
import { PROXY_PATH, getRealmProxyUrl } from '../../../shared/proxy.mjs'
import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { installProxyRoutes } = require('./proxy.cjs')
const { logger } = require('../logs/logs.cjs')
const { createOutboundPolicy } = require('../outboundPolicy.cjs')
const clientFetch = globalThis.fetch

describe('proxy routes', () => {
    let handleUpstream: RequestListener
    const upstream = createServer((req, res) => handleUpstream(req, res))
    const app = express()
    let allowedLocalUrls: string[] = []
    const outboundPolicy = createOutboundPolicy({ getAllowedLocalUrls: () => allowedLocalUrls })
    installProxyRoutes(app, {
        checkAuth: async () => true,
        outboundPolicy,
    })
    const errors: unknown[] = []
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        errors.push(error)
        if (!res.destroyed) res.status((error as { statusCode?: number }).statusCode || 500).end()
    })
    const proxy = createServer(app)
    let url: string
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => {})

    beforeAll(async () => {
        for (const server of [upstream, proxy]) {
            server.listen(0, '127.0.0.1')
            await once(server, 'listening')
        }
        const upstreamPort = (upstream.address() as { port: number }).port
        const proxyPort = (proxy.address() as { port: number }).port
        url = `http://127.0.0.1:${proxyPort}${PROXY_PATH}?url=${encodeURIComponent(`http://127.0.0.1:${upstreamPort}/request`)}`
        allowedLocalUrls = [`http://127.0.0.1:${upstreamPort}/request`]
    })

    beforeEach(() => {
        errors.length = 0
        logError.mockClear()
    })

    afterAll(async () => {
        for (const server of [proxy, upstream]) {
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        }
        await outboundPolicy.close()
        logError.mockRestore()
    })

    it('cancels an upstream request before response headers even without a timeout header', async () => {
        const started = Promise.withResolvers<void>()
        const closed = Promise.withResolvers<void>()
        handleUpstream = (_req, res) => {
            res.once('close', () => closed.resolve())
            started.resolve()
        }
        const controller = new AbortController()
        const aborted = expect(fetch(url, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
        await started.promise
        controller.abort()
        await aborted
        await closed.promise
        expect(errors).toEqual([])
        expect(logError).not.toHaveBeenCalled()
    })

    it('cancels upstream streaming when its client stops reading', async () => {
        const closed = Promise.withResolvers<void>()
        handleUpstream = (_req, res) => {
            res.once('close', () => closed.resolve())
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.write('first chunk')
        }
        const response = await fetch(url)
        const reader = response.body!.getReader()
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('first chunk')
        await reader.cancel()
        await closed.promise
        expect(errors).toEqual([])
        expect(logError).not.toHaveBeenCalled()
    })

    it('does not interrupt another request when a shared-pool client cancels', async () => {
        const started = Promise.withResolvers<void>()
        const closed = Promise.withResolvers<void>()
        let healthyResponse: import('node:http').ServerResponse
        handleUpstream = (req, res) => {
            if (req.headers['x-test-flow'] === 'cancel') {
                res.once('close', () => closed.resolve())
                started.resolve()
                return
            }
            healthyResponse = res
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.write('still ')
        }
        const controller = new AbortController()
        const cancelled = expect(fetch(url, {
            signal: controller.signal,
            headers: { 'risu-header': encodeURIComponent(JSON.stringify({ 'x-test-flow': 'cancel' })) },
        })).rejects.toMatchObject({ name: 'AbortError' })
        await started.promise
        const healthy = await fetch(url)
        const content = healthy.text()
        controller.abort()
        await cancelled
        await closed.promise
        healthyResponse!.end('alive')
        expect(await content).toBe('still alive')
        expect(errors).toEqual([])
        expect(logError).not.toHaveBeenCalled()
    })

    it('preserves normal POST bodies and responses', async () => {
        handleUpstream = (req, res) => {
            let body = ''
            req.on('data', chunk => { body += chunk })
            req.on('end', () => {
                res.writeHead(201, { 'content-type': 'application/json' })
                res.end(body)
            })
        }
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'risu-timeout-ms': '1000' },
            body: JSON.stringify({ text: 'completed' }),
        })
        expect(response.status).toBe(201)
        expect(await response.json()).toEqual({ text: 'completed' })
    })

    it.each([
        { method: 'HEAD', status: 200 },
        { method: 'GET', status: 204 },
        { method: 'GET', status: 304 },
    ])('forwards a bodyless $method response with status $status', async ({ method, status }) => {
        handleUpstream = (_req, res) => { res.writeHead(status).end() }
        const response = await fetch(url, { method })
        expect(response.status).toBe(status)
        expect(await response.text()).toBe('')
    })

    it('forwards form and arbitrary binary bodies with the target content type from risu-header', async () => {
        const cases = [
            {
                body: 'grant_type=authorization_code&code=a%2Bb&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback',
                incomingContentType: 'application/x-www-form-urlencoded',
                targetContentType: 'application/x-www-form-urlencoded; charset=utf-8',
            },
            {
                body: Uint8Array.of(0, 0x7f, 0x80, 0xff, 0x41),
                incomingContentType: 'application/octet-stream',
                targetContentType: 'application/vnd.example.raw-payload',
            },
        ] as const

        for (const testCase of cases) {
            const received = Promise.withResolvers<{ contentType: string | undefined; body: number[] }>()
            handleUpstream = (req, res) => {
                const chunks: Buffer[] = []
                req.on('data', chunk => chunks.push(Buffer.from(chunk)))
                req.on('end', () => {
                    received.resolve({
                        contentType: req.headers['content-type'],
                        body: [...Buffer.concat(chunks)],
                    })
                    res.writeHead(200, { 'content-type': 'text/plain' }).end('received')
                })
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': testCase.incomingContentType,
                    'risu-header': encodeURIComponent(JSON.stringify({ 'content-type': testCase.targetContentType })),
                },
                body: testCase.body,
            })

            expect(response.status).toBe(200)
            expect(await received.promise).toEqual({
                contentType: testCase.targetContentType,
                body: [...Buffer.from(testCase.body)],
            })
        }
    })

    it('rejects unconfigured local destinations before making a request', async () => {
        const called = vi.fn()
        handleUpstream = (_req, res) => { called(); res.end('private') }
        const target = new URL(new URL(url).searchParams.get('url')!)
        target.pathname = '/admin'
        const request = new URL(url)
        request.searchParams.set('url', target.href)
        const response = await fetch(request)
        expect(response.status).toBe(403)
        expect(called).not.toHaveBeenCalled()
    })

    it('does not follow redirects from an authorized endpoint', async () => {
        const destinations: string[] = []
        handleUpstream = (req, res) => {
            destinations.push(req.url!)
            res.writeHead(302, { location: '/admin' }).end()
        }
        const response = await fetch(url)
        expect(response.status).toBe(500)
        expect(destinations).toEqual(['/request'])
    })

    it('still returns a timeout response and cancels the upstream request', async () => {
        const closed = Promise.withResolvers<void>()
        handleUpstream = (_req, res) => { res.once('close', () => closed.resolve()) }
        const response = await fetch(url, { headers: { 'risu-timeout-ms': '1000' } })
        expect(response.status).toBe(504)
        expect(await response.json()).toEqual({ error: 'Proxy request timed out after 1000ms' })
        await closed.promise
        expect(errors).toEqual([])
        expect(logError).not.toHaveBeenCalled()
    })

    it('keeps Realm requests on the fixed upstream without forwarding local credentials', async () => {
        const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"name":"card"}', {
            headers: {
                'content-type': 'application/json', 'set-cookie': 'session=hub; Path=/',
                'cache-control': 'public, max-age=60',
            },
        }))
        try {
            const response = await clientFetch(new URL(getRealmProxyUrl('/hub/info/card?lang=ko'), url), {
                headers: {
                    'x-risu-node-path': encodeURIComponent('http://127.0.0.1/private'),
                    'risu-url': encodeURIComponent('http://127.0.0.1/private'),
                    'risu-auth': 'local-token',
                    authorization: 'Bearer local-secret',
                    cookie: 'session=local-cookie',
                    accept: 'application/json',
                    'accept-language': 'ko',
                    'x-risuai-info': 'Kei;node',
                },
            })
            expect(await response.json()).toEqual({ name: 'card' })
            expect(response.headers.has('set-cookie')).toBe(false)
            expect(response.headers.get('cache-control')).toBe('public, max-age=60')
            expect(upstreamFetch).toHaveBeenCalledOnce()
            const [target, init] = upstreamFetch.mock.calls[0]
            expect(target).toBe('https://sv.risuai.xyz/hub/info/card?lang=ko')
            const headers = new Headers(init?.headers)
            expect(headers.get('origin')).toBe('https://sv.risuai.xyz')
            expect(headers.get('accept')).toBe('application/json')
            expect(headers.get('accept-language')).toBe('ko')
            expect(headers.get('x-risuai-info')).toBe('Kei;node')
            for (const name of ['x-risu-node-path', 'risu-url', 'risu-auth', 'authorization', 'cookie']) {
                expect(headers.has(name)).toBe(false)
            }
        } finally { upstreamFetch.mockRestore() }
    })

    it('cancels a Realm request when its client disconnects before response headers', async () => {
        const started = Promise.withResolvers<void>()
        const closed = Promise.withResolvers<void>()
        const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
            const signal = init!.signal!
            return new Promise<Response>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    closed.resolve()
                    reject(signal.reason)
                }, { once: true })
                started.resolve()
            })
        })
        try {
            const controller = new AbortController()
            const aborted = expect(clientFetch(new URL(getRealmProxyUrl('/resource/image'), url), {
                signal: controller.signal,
            })).rejects.toMatchObject({ name: 'AbortError' })
            await started.promise
            controller.abort()
            await aborted
            await closed.promise
            expect(errors).toEqual([])
            expect(logError).not.toHaveBeenCalled()
        } finally { upstreamFetch.mockRestore() }
    })

    it('keeps the Realm gateway error response for upstream failures', async () => {
        const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Hub unavailable'))
        try {
            const response = await clientFetch(new URL(getRealmProxyUrl('/resource/image'), url))
            expect(response.status).toBe(502)
            expect(await response.json()).toEqual({ error: 'Proxy request failed: Hub unavailable' })
            expect(errors).toEqual([])
        } finally { upstreamFetch.mockRestore() }
    })

    it('returns Realm redirects without making another server request', async () => {
        const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
            status: 302, headers: { location: 'http://127.0.0.1/private' },
        }))
        try {
            const response = await clientFetch(new URL(getRealmProxyUrl('/resource/image'), url), { redirect: 'manual' })
            expect(response.status).toBe(302)
            expect(response.headers.get('location')).toBe('http://127.0.0.1/private')
            expect(upstreamFetch).toHaveBeenCalledOnce()
            expect(upstreamFetch.mock.calls[0][0]).toBe('https://sv.risuai.xyz/resource/image')
            expect(upstreamFetch.mock.calls[0][1]?.redirect).toBe('manual')
        } finally { upstreamFetch.mockRestore() }
    })

    it('does not parse or forward Realm POST requests', async () => {
        const upstreamFetch = vi.spyOn(globalThis, 'fetch')
        try {
            const response = await clientFetch(new URL(getRealmProxyUrl('/hub/report'), url), {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: '{malformed',
            })
            expect(response.status).toBe(405)
            expect(upstreamFetch).not.toHaveBeenCalled()
        } finally { upstreamFetch.mockRestore() }
    })

    it('keeps authority-like Realm paths and destination query values on the fixed origin', async () => {
        const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('image'))
        try {
            const path = getRealmProxyUrl('//evil.example/resource?url=https%3A%2F%2Fother.example&size=large&lang=ko')
            const response = await clientFetch(new URL(path, url))
            expect(await response.text()).toBe('image')
            expect(upstreamFetch.mock.calls[0][0]).toBe('https://sv.risuai.xyz//evil.example/resource?url=https%3A%2F%2Fother.example&size=large&lang=ko')
        } finally { upstreamFetch.mockRestore() }
    })

    it('preserves encoded Realm path segments and search queries without decoding them again', async () => {
        const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))
        const path = '/realm/search%3D%3Da%252Fb%26page%3D%3D2?lang=ko&sort=hot'
        try {
            const response = await clientFetch(new URL(getRealmProxyUrl(path), url))
            expect(await response.json()).toEqual([])
            expect(upstreamFetch.mock.calls[0][0]).toBe(`https://sv.risuai.xyz${path}`)
        } finally { upstreamFetch.mockRestore() }
    })

    it.each([
        '/resource/../../../api/private?lang=ko',
        '/resource/%2e%2e/%2e%2e/api/private?lang=ko',
    ])('keeps upstream traversal inside the local Realm route: %s', async path => {
        const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('realm data'))
        try {
            const response = await clientFetch(new URL(getRealmProxyUrl(path), url))
            expect(await response.text()).toBe('realm data')
            expect(upstreamFetch.mock.calls[0][0]).toBe('https://sv.risuai.xyz/api/private?lang=ko')
        } finally { upstreamFetch.mockRestore() }
    })
})

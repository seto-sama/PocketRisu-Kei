import express from 'express'
import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { installProxyRoutes } = require('./proxy.cjs')
const { logger } = require('../logs/logs.cjs')

describe('ordinary proxy request cancellation', () => {
    let handleUpstream: RequestListener
    const upstream = createServer((req, res) => handleUpstream(req, res))
    const app = express()
    app.use(express.json())
    installProxyRoutes(app, {
        checkAuth: async () => true,
        isCloudflareTunnelRequest: () => false,
    })
    const errors: unknown[] = []
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        errors.push(error)
        if (!res.destroyed) res.status(500).end()
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
        url = `http://127.0.0.1:${proxyPort}/proxy2?url=${encodeURIComponent(`http://127.0.0.1:${upstreamPort}/request`)}`
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
        expect(errors).toEqual([])
        expect(logError).not.toHaveBeenCalled()
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
})

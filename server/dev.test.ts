import { afterAll, beforeAll, expect, it } from 'vitest'
import WebSocket from 'ws'
import { spawnServer, type ServerHandle } from '../test/compat/helpers/spawnServer'
import { createClient, type RisuClient } from '../test/compat/helpers/client'

let server: ServerHandle
let client: RisuClient
let base: string

beforeAll(async () => {
    server = await spawnServer({
        args: ['--dev'],
        env: { NODE_ENV: 'development', NODE_DEBUG: 'pocketrisu', RISU_TUNNEL_DISABLED: 'true' },
    })
    base = `http://127.0.0.1:${server.port}`
    client = await createClient(server.port, server.password)
}, 30_000)

afterAll(async () => { await server?.cleanup() })

it('serves Vite modules and backend startup APIs from the same origin without a build', async () => {
    const page = await fetch(base)
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain('globalThis.__NODE__ = true')
    expect(html).toContain('globalThis.__PATCH_SYNC__ = true')
    expect(html).toContain('globalThis.__POCKETRISU_DEBUG__ = true')
    expect(html).toContain('/@vite/client')

    const auth = await client.fetch('/api/test_auth')
    expect(auth.headers.get('content-type')).toContain('application/json')
    expect(await auth.json()).toMatchObject({ status: 'success' })
    const database = await client.fetch('/api/database')
    expect(database.status).toBe(200)
    expect(await database.json()).toHaveProperty('database')

    for (const path of ['/src/main.ts', '/src/start.ts', '/src/App.svelte']) {
        const module = await fetch(base + path)
        expect(module.status, path + ': ' + await module.text()).toBe(200)
        expect(module.headers.get('content-type')).toContain('javascript')
    }
})

function firstSocketMessage(path: string, protocol?: string): Promise<{ type: string }> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(base.replace('http:', 'ws:') + path, protocol)
        const timer = setTimeout(() => {
            socket.terminate()
            reject(new Error(`No WebSocket message for ${path}`))
        }, 5000)
        socket.once('message', data => {
            clearTimeout(timer)
            socket.close()
            try { resolve(JSON.parse(data.toString())) }
            catch (error) { reject(error) }
        })
        socket.once('error', error => {
            clearTimeout(timer)
            reject(error)
        })
    })
}

it('keeps Vite hot updates and authenticated sync WebSockets on the same server', async () => {
    expect(await firstSocketMessage('/', 'vite-hmr')).toMatchObject({ type: 'connected' })
    const query = new URLSearchParams({ 'risu-auth': client.token, 'client-id': client.clientId })
    expect(await firstSocketMessage(`/sync?${query}`)).toMatchObject({ type: 'sync-ready' })
})

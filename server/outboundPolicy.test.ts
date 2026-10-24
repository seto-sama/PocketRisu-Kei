import { createServer, type RequestListener, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { createOutboundPolicy: createPolicy } = require('./outboundPolicy.cjs') as {
    createOutboundPolicy: (options?: {
        getAllowedLocalUrls?: () => string[]
        lookup?: (hostname: string, options: object, callback: (error: Error | null, records: any) => void) => void
    }) => {
        close(): Promise<void>
        prepare(url: string | URL): Promise<{ url: string; dispatcher: unknown; release(): void }>
    }
}
const { executeUpstreamRequest } = require('./upstreamRequest.cjs')

function lookupWith(records: Array<{ address: string; family: number }>) {
    return vi.fn((_hostname: string, options: { all?: boolean }, callback: Function) => {
        callback(null, options.all ? records : records[0])
    })
}

describe('server outbound destination policy', () => {
    const policies: ReturnType<typeof createPolicy>[] = []
    const servers: Server[] = []

    function createOutboundPolicy(options?: Parameters<typeof createPolicy>[0]) {
        const policy = createPolicy(options)
        policies.push(policy)
        return policy
    }

    async function startUpstream(handler: RequestListener, host = '127.0.0.1', port = 0) {
        const server = createServer(handler)
        server.listen(port, host)
        await once(server, 'listening')
        servers.push(server)
        const actualPort = (server.address() as { port: number }).port
        return { url: `http://${host}:${actualPort}`, port: actualPort }
    }

    async function readUpstream(policy: ReturnType<typeof createPolicy>, url: string) {
        const response = await executeUpstreamRequest({ url, method: 'GET', outboundPolicy: policy })
        expect(response.status).toBe(200)
        return new Response(response.body).text()
    }

    afterEach(async () => {
        for (const server of servers) server.closeAllConnections()
        await Promise.all(policies.splice(0).map(policy => policy.close()))
        await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve())
        })))
    })

    it('accepts public HTTP(S), preserves encoded paths, and rejects other protocols or credentials', async () => {
        const policy = createOutboundPolicy({ lookup: lookupWith([{ address: '93.184.216.34', family: 4 }]) })
        for (const protocol of ['http', 'https']) {
            const url = `${protocol}://provider.example/model/provider%2Fmodel/converse`
            const target = await policy.prepare(url)
            expect(target.url).toBe(url)
            target.release()
        }
        for (const url of ['ftp://provider.example/file', 'https://user:secret@provider.example/api']) {
            await expect(policy.prepare(url)).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED' })
        }
    })

    it('rejects restricted literal IPs across IPv4, IPv6, mapped IPv4, and reserved ranges', async () => {
        const policy = createOutboundPolicy()
        for (const host of [
            '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.5',
            '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '0.0.0.0',
            '[::]', '[::1]', '[fe80::1]', '[fc00::1]', '[2001:db8::1]', '[::ffff:127.0.0.1]', '[ff02::1]',
        ]) {
            await expect(policy.prepare(`http://${host}/`), host).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED' })
        }
    })

    it('allows configured private endpoints only at their exact origin and path subtree', async () => {
        const base = 'http://127.0.0.1:8188/api/v1/chat/completions'
        const policy = createOutboundPolicy({ getAllowedLocalUrls: () => [base] })
        for (const url of [base, `${base}/extra`]) {
            const target = await policy.prepare(url)
            expect(target.url).toBe(url)
            target.release()
        }
        for (const url of [
            `${base}-extra`, `${base}/%2e%2e%2fadmin`, `${base}/%252e%252e%252fadmin`,
            'http://127.0.0.1:8189/api/v1/chat/completions',
        ]) {
            await expect(policy.prepare(url)).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED' })
        }
    })

    it('never grants configured exceptions for metadata or reserved addresses', async () => {
        const urls = ['http://169.254.169.254/', 'http://192.0.2.1/', 'http://[fd00:ec2::254]/']
        const policy = createOutboundPolicy({ getAllowedLocalUrls: () => urls })
        for (const url of urls) {
            await expect(policy.prepare(url)).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED' })
        }
    })

    it('rechecks complete DNS answers and skips local configuration for public addresses', async () => {
        const records = [{ address: '93.184.216.34', family: 4 }]
        const getAllowedLocalUrls = vi.fn(() => [])
        const policy = createOutboundPolicy({ getAllowedLocalUrls, lookup: lookupWith(records) })
        const first = await policy.prepare('https://provider.example/api')
        first.release()
        expect(getAllowedLocalUrls).not.toHaveBeenCalled()

        records.push({ address: '127.0.0.1', family: 4 })
        await expect(policy.prepare('https://provider.example/api')).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED' })
        records.shift()
        await expect(policy.prepare('https://provider.example/api')).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED' })
    })

    it('routes requests to the current DNS address and requested origin', async () => {
        const first = await startUpstream((_req, res) => res.end('first'))
        await startUpstream((_req, res) => res.end('second'), '127.0.0.2', first.port)
        const other = await startUpstream((_req, res) => res.end('other origin'))
        const origin = `http://provider.example:${first.port}`
        const otherOrigin = `http://provider.example:${other.port}`
        const records = [{ address: '127.0.0.1', family: 4 }]
        const policy = createOutboundPolicy({
            lookup: lookupWith(records), getAllowedLocalUrls: () => [origin, otherOrigin],
        })
        expect(await readUpstream(policy, origin + '/api')).toBe('first')
        records[0].address = '127.0.0.2'
        expect(await readUpstream(policy, origin + '/api')).toBe('second')
        records[0].address = '127.0.0.1'
        expect(await readUpstream(policy, otherOrigin + '/api')).toBe('other origin')
    })

    it('reuses validated connections across repeated requests', async () => {
        const connections = new Set<number>()
        const upstream = await startUpstream((req, res) => {
            connections.add(req.socket.remotePort!)
            res.end('reused')
        })
        const target = upstream.url + '/api'
        const policy = createOutboundPolicy({ getAllowedLocalUrls: () => [target] })
        for (let i = 0; i < 3; i++) expect(await readUpstream(policy, target)).toBe('reused')
        expect(connections.size).toBeLessThan(3)
    })

    it('revokes access before another request reaches an already pooled private endpoint', async () => {
        const received = vi.fn((_req, res) => res.end('allowed'))
        const upstream = await startUpstream(received)
        const target = upstream.url + '/api'
        let allowed = [target]
        const policy = createOutboundPolicy({ getAllowedLocalUrls: () => allowed })
        expect(await readUpstream(policy, target)).toBe('allowed')
        allowed = []
        await expect(readUpstream(policy, target)).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED' })
        expect(received).toHaveBeenCalledOnce()
    })

    it('keeps an acquired connection usable while other destinations fill the cache', async () => {
        const upstream = await startUpstream((_req, res) => res.end('still usable'))
        const target = upstream.url + '/api'
        const policy = createOutboundPolicy({ getAllowedLocalUrls: () => [target] })
        const first = await policy.prepare(target)
        const leases = []
        for (let port = 8001; port < 8065; port++) {
            leases.push(await policy.prepare(`https://1.1.1.1:${port}/api`))
        }
        const response = await fetch(first.url, { dispatcher: first.dispatcher } as RequestInit & { dispatcher: unknown })
        expect(await response.text()).toBe('still usable')
        first.release()
        for (const lease of leases) lease.release()
    })
})

import express from 'express'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import assetRoutes from './batch.cjs'
import { encodeAssetBatch, decodeAssetBatch } from '../../../../src/ts/storage/assetTransport'
import { encodeBinaryMessage, BINARY_MESSAGE_CONTENT_TYPE } from '../../../../src/ts/network/binaryMessage'

describe('binary asset API', () => {
    const values = new Map<string, Uint8Array>()
    const write = vi.fn((key: string, value: Uint8Array) => values.set(key, Uint8Array.from(value)))
    const app = express()
    app.use(express.json())
    assetRoutes.installAssetBatchRoutes(app, {
        checkAuth: async () => true, requireSyncClientId: () => true,
        kvGet: key => values.get(key) ?? null, kvSet: write,
        readInlayInfoPayload: async id => id === 'canonical' ? Buffer.from('{"name":"image"}') : null,
        transaction: callback => callback,
    })
    const server = createServer(app)
    let base: string
    beforeAll(async () => {
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    })
    beforeEach(() => { values.clear(); write.mockClear() })
    afterAll(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    })
    const upload = (body: Uint8Array<ArrayBuffer>) => fetch(base + '/api/assets/bulk-write', {
        method: 'POST', headers: { 'content-type': BINARY_MESSAGE_CONTENT_TYPE }, body,
    })

    it('round-trips arbitrary bytes, empty assets and Unicode keys, and reads canonical inlay metadata', async () => {
        const entries = [
            { key: 'assets/한글.png', value: Uint8Array.of(0, 255, 128, 13, 10) },
            { key: 'assets/empty', value: new Uint8Array() },
        ]
        expect((await upload(encodeAssetBatch(entries))).status).toBe(200)
        const response = await fetch(base + '/api/assets/bulk-read', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify([...entries.map(entry => entry.key), 'missing', 'inlay_info/canonical']),
        })
        expect(response.headers.get('content-type')).toContain(BINARY_MESSAGE_CONTENT_TYPE)
        expect(decodeAssetBatch(new Uint8Array(await response.arrayBuffer()))).toEqual([
            ...entries, { key: 'inlay_info/canonical', value: new TextEncoder().encode('{"name":"image"}') },
        ])
    })

    it('rejects a database write before writing any assets', async () => {
        const response = await upload(encodeAssetBatch([
            { key: 'assets/valid', value: Uint8Array.of(1) },
            { key: 'database/database.bin', value: Uint8Array.of(2) },
        ]))
        expect(response.status).toBe(400)
        expect((await response.json()).code).toBe('DATABASE_BIN_PROJECTION_ONLY')
        expect(write).not.toHaveBeenCalled()
    })

    it.each([
        [{ key: 'assets/valid', size: 1 }, { key: 'assets/truncated', size: 2 }],
        [{ key: 'assets/trailing', size: 0 }],
        [{ key: 'assets/negative', size: -1 }],
        [{ key: 123, size: 1 }],
    ])('validates the complete batch before writing: %j', async (...entries) => {
        const response = await upload(encodeBinaryMessage({ entries }, Uint8Array.of(255)))
        expect(response.status).toBe(400)
        expect(write).not.toHaveBeenCalled()
    })
})

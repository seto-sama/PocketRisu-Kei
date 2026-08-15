import { afterAll, describe, expect, test } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'

const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

describe('inlay asset byte ranges', () => {
  test('serves media ranges and keeps full responses cacheable', async () => {
    const media = Buffer.from('0123456789abcdef')
    const srv = await spawnServer({
      seedSave: async (saveDir) => {
        const inlayDir = path.join(saveDir, 'inlays')
        const thumbnailDir = path.join(inlayDir, '.video-thumbnails')
        await mkdir(inlayDir, { recursive: true })
        await mkdir(thumbnailDir, { recursive: true })
        await writeFile(path.join(inlayDir, 'range-test.mp4'), media)
        await writeFile(
          path.join(inlayDir, 'range-test.meta.json'),
          JSON.stringify({ ext: 'mp4', name: 'range-test.mp4', type: 'video' }),
        )
        await writeFile(path.join(thumbnailDir, 'range-test.webp'), Buffer.from('cached-thumbnail'))
      },
    })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    const assetKey = Buffer.from('inlay/range-test', 'utf8').toString('hex')
    const sessionResponse = await client.fetch('/api/session', { method: 'POST' })
    expect(sessionResponse.status).toBe(200)
    const sessionCookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0]
    expect(sessionCookie).toBeTruthy()
    const fetchAsset = (headers?: HeadersInit) => fetch(
      `http://127.0.0.1:${srv.port}/api/asset/${assetKey}`,
      { headers: { cookie: sessionCookie!, ...headers } },
    )

    const rangeResponse = await fetchAsset({ range: 'bytes=4-7' })
    expect(rangeResponse.status).toBe(206)
    expect(rangeResponse.headers.get('accept-ranges')).toBe('bytes')
    expect(rangeResponse.headers.get('content-range')).toBe(`bytes 4-7/${media.length}`)
    expect(rangeResponse.headers.get('content-length')).toBe('4')
    expect(Buffer.from(await rangeResponse.arrayBuffer())).toEqual(media.subarray(4, 8))

    const fullResponse = await fetchAsset()
    expect(fullResponse.status).toBe(200)
    expect(fullResponse.headers.get('cache-control')).toContain('immutable')
    expect(fullResponse.headers.get('content-length')).toBe(String(media.length))
    expect(Buffer.from(await fullResponse.arrayBuffer())).toEqual(media)

    const thumbnailKey = Buffer.from('inlay_video_thumb/range-test', 'utf8').toString('hex')
    const thumbnailResponse = await fetch(
      `http://127.0.0.1:${srv.port}/api/asset/${thumbnailKey}`,
      { headers: { cookie: sessionCookie! } },
    )
    expect(thumbnailResponse.status).toBe(200)
    expect(thumbnailResponse.headers.get('content-type')).toContain('image/webp')
    expect(thumbnailResponse.headers.get('cache-control')).toContain('max-age=86400')
    expect(Buffer.from(await thumbnailResponse.arrayBuffer())).toEqual(Buffer.from('cached-thumbnail'))

    const invalidRangeResponse = await fetchAsset({ range: `bytes=${media.length}-` })
    expect(invalidRangeResponse.status).toBe(416)
    expect(invalidRangeResponse.headers.get('content-range')).toBe(`bytes */${media.length}`)
  })
})

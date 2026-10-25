import { afterAll, describe, expect, test } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { encodeInlayAsset } from '../../src/ts/storage/inlayTransport'

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

  test('stores uploaded video previews, keeps existing previews, and removes them with the original', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    const hex = (key: string) => Buffer.from(key, 'utf8').toString('hex')
    const session = await client.fetch('/api/session', { method: 'POST' })
    const cookie = session.headers.get('set-cookie')!.split(';', 1)[0]
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=',
      'base64',
    )
    const upload = await client.fetch('/api/write', {
      method: 'POST',
      headers: { 'file-path': hex('inlay/video-upload'), 'content-type': 'application/octet-stream' },
      body: encodeInlayAsset({ type: 'video', ext: 'mp4', name: 'clip.mp4', mime: 'video/mp4' }, Buffer.from('original-video')),
    })
    expect(upload.status).toBe(200)
    const url = `/api/asset/${hex('inlay_video_thumb/video-upload')}`
    const fetchThumbnail = (headers?: HeadersInit) => client.fetch(url, { headers: { cookie, ...headers } })
    expect((await fetchThumbnail()).status).toBe(404)

    const saveThumbnail = (id: string, body: Buffer) => client.fetch(`/api/inlays/${id}/video-thumbnail`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body,
    })
    expect((await saveThumbnail('missing-video', png)).status).toBe(400)
    expect((await saveThumbnail('video-upload', Buffer.from('invalid-image'))).status).toBe(400)
    expect((await saveThumbnail('video-upload', png)).status).toBe(204)
    const first = await fetchThumbnail()
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/webp')
    const preview = Buffer.from(await first.arrayBuffer())
    expect(preview.length).toBeGreaterThan(0)
    const etag = first.headers.get('etag')!
    expect((await saveThumbnail('video-upload', png)).status).toBe(204)
    expect((await fetchThumbnail({ 'if-none-match': etag })).status).toBe(304)
    expect(Buffer.from(await (await fetchThumbnail()).arrayBuffer())).toEqual(preview)

    expect((await client.fetch('/api/remove', { headers: { 'file-path': hex('inlay/video-upload') } })).status).toBe(200)
    expect((await fetchThumbnail()).status).toBe(404)
    expect((await saveThumbnail('video-upload', png)).status).toBe(400)
  })
})

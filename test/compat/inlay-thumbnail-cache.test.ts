import { afterAll, expect, test } from 'vitest'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { encodeInlayAsset } from '../../src/ts/storage/inlayTransport'

let server: ServerHandle

afterAll(async () => { await server?.cleanup() })

test('preserves the cached image preview through compression and removes it with the original', async () => {
  server = await spawnServer()
  const client = await createClient(server.port, server.password)
  const session = await client.fetch('/api/session', { method: 'POST' })
  const cookie = session.headers.get('set-cookie')!.split(';', 1)[0]
  const id = 'cached-image'
  const hex = (key: string) => Buffer.from(key, 'utf8').toString('hex')
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=',
    'base64',
  )
  const upload = await client.fetch('/api/write', {
    method: 'POST',
    headers: { 'file-path': hex(`inlay/${id}`), 'content-type': 'application/octet-stream' },
    body: encodeInlayAsset({ type: 'image', ext: 'png', name: 'image.png', mime: 'image/png' }, image),
  })
  expect(upload.status).toBe(200)

  const thumbnailUrl = `/api/asset/${hex(`inlay_thumb/${id}`)}`
  const first = await client.fetch(thumbnailUrl, { headers: { cookie } })
  expect(first.status).toBe(200)
  expect(first.headers.get('content-type')).toBe('image/webp')
  const preview = Buffer.from(await first.arrayBuffer())
  expect(preview.length).toBeGreaterThan(0)
  const etag = first.headers.get('etag')!
  const cachePath = path.join(server.cwd, 'save', 'inlays', '.image-thumbnails', `${id}.webp`)
  const before = (await stat(cachePath)).mtimeMs

  const compression = await client.fetch('/api/inlays/compress', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'webp', size: 'original', lossy: false }),
  })
  expect(compression.status).toBe(200)
  const events = (await compression.text()).split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)))
  expect(events.at(-1)).toMatchObject({ type: 'done', compressed: 1, skipped: 0 })
  expect((await stat(cachePath)).mtimeMs).toBe(before)

  const cached = await client.fetch(thumbnailUrl, { headers: { cookie, 'if-none-match': etag } })
  expect(cached.status).toBe(304)
  const repeat = await client.fetch(thumbnailUrl, { headers: { cookie } })
  expect(Buffer.from(await repeat.arrayBuffer())).toEqual(preview)
  expect((await stat(cachePath)).mtimeMs).toBe(before)

  expect((await client.fetch('/api/remove', { headers: { 'file-path': hex(`inlay/${id}`) } })).status).toBe(200)
  await expect(access(cachePath)).rejects.toThrow()
  expect((await client.fetch(thumbnailUrl, { headers: { cookie } })).status).toBe(404)
})

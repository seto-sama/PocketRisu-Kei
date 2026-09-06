import { afterAll, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'

let server: ServerHandle | undefined
afterAll(async () => { await server?.cleanup() })

test('reference scans protect hidden content without enumerating it over HTTP', async () => {
  server = await spawnServer()
  const client = await createClient(server.port, server.password)
  const secret = 'Private chat text {{inlay::private-image}}'
  const initialized = await client.fetch('/api/database', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, database: {
      characterOrder: [{ name: 'Local', localOnly: true, data: ['private-character'] }],
      characters: [{ chaId: 'private-character', name: 'Private', chats: [{
        id: 'private-chat', message: [{ role: 'char', data: secret }],
      }] }],
    } }),
  })
  expect(initialized.status).toBe(200)
  const headers = {
    'content-type': 'application/json',
    'x-forwarded-host': 'fixture.trycloudflare.com',
  }
  const projection = await (await client.fetch('/api/database', { headers })).json() as any
  expect(projection.database.characters).toEqual([])

  for (const [kind, candidate] of [['translation', secret], ['inlay', 'private-image']]) {
    const response = await client.fetch('/api/database/content-references', {
      method: 'POST', headers, body: JSON.stringify({ kind, candidates: [candidate, 'unused'] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ kind, scannedAt: expect.any(Number), used: [true, false] })
  }
  const invalid = await client.fetch('/api/database/content-references', {
    method: 'POST', headers, body: JSON.stringify({ kind: 'translation' }),
  })
  expect(invalid.status).toBe(400)
  const unauthenticated = await fetch(`http://127.0.0.1:${server.port}/api/database/content-references`, {
    method: 'POST', headers, body: JSON.stringify({ kind: 'translation', candidates: [] }),
  })
  expect(unauthenticated.status).toBe(400)
  expect(await unauthenticated.json()).toEqual({ error: 'No auth header' })
  const legacy = await client.fetch('/api/database/content-references?kind=translation', { headers })
  expect(await legacy.text()).not.toContain(secret)
})

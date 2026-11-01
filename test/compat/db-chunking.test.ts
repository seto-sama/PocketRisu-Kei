import { describe, test, expect, afterAll } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { normalizeBackup } from './helpers/normalize.js'

// Chunk legacy blobs and migration artifacts above 4 KB.
const CHUNK_ENV = { POCKETRISU_CHUNK_THRESHOLD: '4096' }

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map((s) => s.cleanup())) })

async function boot(): Promise<{ client: RisuClient; srv: ServerHandle }> {
  const srv = await spawnServer({ env: CHUNK_ENV })
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  return { client, srv }
}

function oversizedSeed(): Buffer {
  return createSeedBackup({ characterCount: 5, chatsPerCharacter: 2, messagesPerChat: 1000 })
}

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
function bigDbBlob(salt = ''): Buffer {
  const characters = Array.from({ length: 5 }, (_, ci) => ({
    name: `Char${ci}`, chaId: `c${ci}`, type: 'character', chatPage: 0, image: '', desc: 'x', firstMessage: 'hi',
    chats: [{
      id: `chat${ci}`, name: 'c', lastDate: 0, localLore: [], scriptstate: {}, note: '',
      message: Array.from({ length: 2000 }, (_, mi) => ({ role: mi % 2 ? 'char' : 'user', data: `msg ${mi} of char ${ci} ${salt} ${'x'.repeat(20)}` })),
    }],
  }))
  const database = { characters, apiType: 'openai', personas: [{ name: 'D', icon: '', personaPrompt: '' }], botPresets: [], botPresetsId: 0, selectedCharacter: 0 }
  return Buffer.concat([MAGIC_RAW, packr.encode(database)])
}
const DB_BLOB_HEX = Buffer.from('database/database.bin', 'utf-8').toString('hex')

async function getStats(client: RisuClient): Promise<any> {
  const res = await client.fetch('/api/db/stats')
  expect(res.status).toBe(200)
  return res.json()
}

async function exportedDatabaseContains(client: RisuClient, text: string): Promise<boolean> {
  const { raw } = normalizeBackup(await client.exportBackup())
  return JSON.stringify(raw).includes(text)
}

function expectNoLiveDatabaseBlob(stats: any) {
  expect(stats.chunks.liveChunked).toBe(false)
  expect(stats.prefixes['database/database.bin']).toEqual({ totalSize: 0, count: 0 })
}

describe('chunking lifecycle (real server, low threshold)', () => {
  test('relational DB exports to standard .bin and round-trips into a fresh server', async () => {
    const { client } = await boot()
    await client.importBackup(oversizedSeed())

    const exported = await client.exportBackup()
    expect(exported.byteLength).toBeGreaterThan(4096)

    const { client: client2 } = await boot()
    const r2 = await client2.importBackup(exported)
    expect(r2.ok).toBe(true)

    const s2 = await getStats(client2)
    expectNoLiveDatabaseBlob(s2)
    const charRes = await client2.fetch('/api/db/stats/characters')
    expect(charRes.status).toBe(200)
    const chars = await charRes.json()
    expect(chars.characters.length).toBeGreaterThanOrEqual(5)
  })

  test('pre-SQLite hex save folder keeps a chunked immutable migration artifact', async () => {
    // Plant an old file-based save folder (hex-named files, no SQLite marker)
    // with an oversized database.bin before the server boots.
    const srv = await spawnServer({
      env: CHUNK_ENV,
      seedSave: async (saveDir) => {
        await writeFile(path.join(saveDir, DB_BLOB_HEX), bigDbBlob('HEX'))
      },
    })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    // Boot installs rows and removes the live blob. The exact pre-cutover bytes
    // remain as a chunkable migration-backup artifact.
    const s = await getStats(client)
    expectNoLiveDatabaseBlob(s)
    expect(s.chunks.count).toBeGreaterThan(1)
    expect(await exportedDatabaseContains(client, 'HEX')).toBe(true)
  })
})

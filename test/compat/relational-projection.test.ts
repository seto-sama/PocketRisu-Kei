import { afterAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeRisuDat, normalizeBackup } from './helpers/normalize.js'
import utilsPkg from '../../server/node/utils.cjs'

const { calculateHash } = utilsPkg as any

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

async function bootClients(count: number) {
  const server = await spawnServer()
  servers.push(server)
  const clients = await Promise.all(
    Array.from({ length: count }, () => createClient(server.port, server.password)),
  )
  return { server, clients }
}

function chat(id: string, text: string) {
  return {
    id,
    name: id,
    message: [{ chatId: `${id}-message-0`, role: 'char', data: text }],
  }
}

function database(owner = 'initial') {
  return {
    owner,
    language: 'ko',
    characters: [{
      chaId: 'character-1',
      name: 'Character',
      chats: [chat('chat-a', 'A0'), chat('chat-b', 'B0'), chat('chat-c', 'C0')],
    }],
  }
}

async function initialize(client: RisuClient, value = database()) {
  return client.fetch('/api/database', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ database: value, expectedRevision: 0 }),
  })
}

async function readChat(client: RisuClient, index: number, id: string) {
  const response = await client.fetch(`/api/chat-content/character-1/${index}`, {
    headers: { 'x-chat-id': id },
  })
  expect(response.status).toBe(200)
  return {
    etag: response.headers.get('x-chat-etag')!,
    chat: decodeRisuDat(Buffer.from(await response.arrayBuffer())) as any,
  }
}

async function writeChat(
  client: RisuClient,
  index: number,
  id: string,
  value: unknown,
  expectedEtag: string,
) {
  return client.fetch(`/api/chat-content/character-1/${index}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chat-id': id,
      'x-chat-if-match': expectedEtag,
    },
    body: JSON.stringify(value),
  })
}

describe('relational projection boundary (real server)', () => {
  test('three first-run clients elect one initializer without losing its chat body', async () => {
    const { clients } = await bootClients(3)
    const pristine = await clients[0].fetch('/api/database')
    expect(pristine.status).toBe(200)
    expect(await pristine.json()).toMatchObject({
      database: null,
      initialized: false,
      revision: 0,
    })

    const responses = await Promise.all(clients.map((client, index) =>
      initialize(client, database(`client-${index + 1}`))))
    expect(responses.map(response => response.status).sort()).toEqual([200, 409, 409])

    const projection = await (await clients[1].fetch('/api/database')).json() as any
    expect(['client-1', 'client-2', 'client-3']).toContain(projection.database.owner)
    expect(projection.database.characters[0].chats[0]).not.toHaveProperty('message')

    const hydrated = await readChat(clients[2], 0, 'chat-a')
    expect(hydrated.chat.message).toMatchObject([
      { chatId: 'chat-a-message-0', role: 'char', data: 'A0' },
    ])
    const stats = await (await clients[0].fetch('/api/db/stats')).json() as any
    expect(stats.prefixes['database/database.bin']).toEqual({ totalSize: 0, count: 0 })
    const characterStats = await (
      await clients[0].fetch('/api/db/stats/characters')
    ).json() as any
    expect(characterStats.characters).toEqual(expect.arrayContaining([
      expect.objectContaining({ chaId: 'character-1', chatBytes: expect.any(Number) }),
    ]))
    expect(characterStats.characters[0].chatBytes).toBeGreaterThan(0)
    expect(characterStats.chatBytesNote).toBe('relational msgpack payload bytes')

    const filePath = Buffer.from('database/database.bin').toString('hex')
    expect((await clients[0].fetch('/api/remove', {
      headers: { 'file-path': filePath },
    })).status).toBe(410)
    expect((await clients[0].fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': filePath,
      },
      body: new Uint8Array([1]),
    })).status).toBe(428)
    expect((await clients[0].fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': filePath,
      },
      body: JSON.stringify({ patch: [], expectedHash: 'legacy' }),
    })).status).toBe(410)
  })

  test('three clients can commit unrelated chats, while same-chat stale CAS conflicts', async () => {
    const { clients } = await bootClients(3)
    expect((await initialize(clients[0])).status).toBe(200)

    const ids = ['chat-a', 'chat-b', 'chat-c']
    const current = await Promise.all(ids.map((id, index) =>
      readChat(clients[index], index, id)))
    const writes = await Promise.all(ids.map((id, index) => writeChat(
      clients[index],
      index,
      id,
      {
        ...current[index].chat,
        message: [
          ...current[index].chat.message,
          { chatId: `${id}-message-1`, role: 'user', data: `from-client-${index + 1}` },
        ],
      },
      current[index].etag,
    )))
    expect(writes.map(response => response.status)).toEqual([200, 200, 200])

    const sharedA = await Promise.all([
      readChat(clients[0], 0, 'chat-a'),
      readChat(clients[1], 0, 'chat-a'),
    ])
    expect(sharedA[0].etag).toBe(sharedA[1].etag)
    const conflicting = await Promise.all([
      writeChat(clients[0], 0, 'chat-a', {
        ...sharedA[0].chat,
        message: [...sharedA[0].chat.message, {
          chatId: 'chat-a-race-1', role: 'user', data: 'race-one',
        }],
      }, sharedA[0].etag),
      writeChat(clients[1], 0, 'chat-a', {
        ...sharedA[1].chat,
        message: [...sharedA[1].chat.message, {
          chatId: 'chat-a-race-2', role: 'user', data: 'race-two',
        }],
      }, sharedA[1].etag),
    ])
    expect(conflicting.map(response => response.status).sort()).toEqual([200, 409])

    const { raw } = normalizeBackup(await clients[2].exportBackup())
    const chats = (raw as any).characters[0].chats
    expect(chats[0].message.map((message: any) => message.data)).toEqual(
      expect.arrayContaining(['from-client-1']),
    )
    expect(chats[1].message.map((message: any) => message.data)).toEqual(
      expect.arrayContaining(['from-client-2']),
    )
    expect(chats[2].message.map((message: any) => message.data)).toEqual(
      expect.arrayContaining(['from-client-3']),
    )
    const raceMessages = chats[0].message.map((message: any) => message.data)
    expect(raceMessages.filter((value: string) =>
      value === 'race-one' || value === 'race-two')).toHaveLength(1)
  })

  test('metadata patches reconcile a loaded chat without dropping its hot body', async () => {
    const { clients } = await bootClients(1)
    const [client] = clients
    expect((await initialize(client)).status).toBe(200)
    expect((await readChat(client, 0, 'chat-a')).chat.name).toBe('chat-a')

    const startup = await (await client.fetch('/api/database')).json() as any
    const patched = await client.fetch('/api/database', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedHash: calculateHash(startup.database).toString(16),
        patch: [{
          op: 'replace',
          path: '/characters/0/chats/0/name',
          value: 'renamed while cached',
        }],
      }),
    })
    const patchBody = await patched.text()
    expect(patched.status, patchBody).toBe(200)

    const hydrated = await readChat(client, 0, 'chat-a')
    expect(hydrated.chat.name).toBe('renamed while cached')
    expect(hydrated.chat.message[0].data).toBe('A0')
  })
})

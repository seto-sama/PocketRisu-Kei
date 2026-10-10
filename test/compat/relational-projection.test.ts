import { afterAll, describe, expect, test } from 'vitest'
import { createDelta } from '../../shared/guardedDelta.mjs'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeRisuDat, normalizeBackup } from './helpers/normalize.js'

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
  return decodeRisuDat(Buffer.from(await response.arrayBuffer())) as any
}

async function writeChat(
  client: RisuClient,
  index: number,
  id: string,
  before: unknown,
  after: unknown,
) {
  return client.fetch(`/api/chat-content/character-1/${index}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-chat-id': id,
    },
    body: JSON.stringify({ changes: createDelta(before, after) }),
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
    expect(hydrated.message).toMatchObject([
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
  })

  test('three clients can commit unrelated chats while overlapping edits conflict', async () => {
    const { clients } = await bootClients(3)
    expect((await initialize(clients[0])).status).toBe(200)

    const ids = ['chat-a', 'chat-b', 'chat-c']
    const current = await Promise.all(ids.map((id, index) =>
      readChat(clients[index], index, id)))
    const writes = await Promise.all(ids.map((id, index) => writeChat(
      clients[index],
      index,
      id,
      current[index],
      {
        ...current[index],
        message: [
          ...current[index].message,
          { chatId: `${id}-message-1`, role: 'user', data: `from-client-${index + 1}` },
        ],
      },
    )))
    expect(writes.map(response => response.status)).toEqual([200, 200, 200])

    const sharedA = await Promise.all([
      readChat(clients[0], 0, 'chat-a'),
      readChat(clients[1], 0, 'chat-a'),
    ])
    const conflicting = await Promise.all([
      writeChat(clients[0], 0, 'chat-a', sharedA[0], {
        ...sharedA[0],
        message: sharedA[0].message.map((message: any, index: number) =>
          index === 0 ? { ...message, data: 'race-one' } : message),
      }),
      writeChat(clients[1], 0, 'chat-a', sharedA[1], {
        ...sharedA[1],
        message: sharedA[1].message.map((message: any, index: number) =>
          index === 0 ? { ...message, data: 'race-two' } : message),
      }),
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
    expect(['race-one', 'race-two']).toContain(chats[0].message[0].data)
  })
})

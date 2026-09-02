/**
 * Upstream backup import tests.
 *
 * Verifies that a .bin backup exported from upstream RisuAI can be
 * imported into NodeOnly and that core data survives a round-trip.
 *
 * Fixture: test/fixtures/upstream/upstream-backup.bin
 * Deterministic, synthetic, and tracked so this suite cannot silently skip.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { normalizeBackup, fingerprintAssets } from './helpers/normalize.js'

const FIXTURE_PATH = path.resolve(
  import.meta.dirname, '..', 'fixtures', 'upstream', 'upstream-backup.bin',
)
// Reviewed synthetic fixture. Updating this digest requires re-running the
// privacy/content inspection before the replacement binary is committed.
const REVIEWED_FIXTURE_SHA256 = '92d91f94903edecd892ab209ec94f10e86823df90963fbccfb9c7a7b21f1e9d4'
const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(s => s.cleanup()))
})

describe('upstream backup import', () => {
  test('upstream .bin can be decoded locally', () => {
    const upstreamBin = readFileSync(FIXTURE_PATH)
    expect(createHash('sha256').update(upstreamBin).digest('hex'))
      .toBe(REVIEWED_FIXTURE_SHA256)
    const { normalized } = normalizeBackup(upstreamBin)
    expect(normalized).toMatchObject({
      characterCount: 2,
      personaCount: 1,
    })
    expect(normalized.characters.map(character => character.chaId)).toEqual([
      'fixture-character-alpha',
      'fixture-character-beta',
    ])
  })

  test('imported upstream data survives re-export', async () => {
    const upstreamBin = readFileSync(FIXTURE_PATH)
    const before = normalizeBackup(upstreamBin)

    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    await client.importBackup(upstreamBin)
    const exported = await client.exportBackup()
    const after = normalizeBackup(exported)

    // Character count must match
    expect(after.normalized.characterCount).toBe(before.normalized.characterCount)

    // Each character's name, chat count, and message content must survive
    for (const beforeChar of before.normalized.characters) {
      const afterChar = after.normalized.characters.find(c => c.chaId === beforeChar.chaId)
      expect(afterChar, `character ${beforeChar.name} (${beforeChar.chaId}) missing after import`).toBeDefined()
      expect(afterChar!.name).toBe(beforeChar.name)
      expect(afterChar!.chatCount).toBe(beforeChar.chatCount)
      expect(afterChar!.firstMessages).toEqual(beforeChar.firstMessages)
    }

    // Persona count must survive
    expect(after.normalized.personaCount).toBe(before.normalized.personaCount)
  })

  test('upstream assets survive import with intact payload', async () => {
    const upstreamBin = readFileSync(FIXTURE_PATH)
    const beforeFingerprints = fingerprintAssets(upstreamBin)
    expect(beforeFingerprints).not.toHaveLength(0)

    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    await client.importBackup(upstreamBin)
    const exported = await client.exportBackup()
    const afterFingerprints = fingerprintAssets(exported)

    // Count and payload hashes must all match
    expect(afterFingerprints.length).toBe(beforeFingerprints.length)
    expect(afterFingerprints).toEqual(beforeFingerprints)
  })
})

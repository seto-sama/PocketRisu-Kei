// @vitest-environment node
import Database from './sqlite.cjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import appDataStorePkg from './appDataStore.cjs'
import chunkStorePkg from './chunkStore.cjs'
import snapshotWorkerPkg from './snapshotWorker.cjs'
import utilsPkg from './utils.cjs'

const { createAppDataStore } = appDataStorePkg as any
const { createChunkStore } = chunkStorePkg as any
const { createRelationalSnapshot } = snapshotWorkerPkg as any
const { decodeRisuSave } = utilsPkg as any
const directories: string[] = []

async function createFixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'snapshot-worker-'))
    directories.push(directory)
    const dbPath = path.join(directory, 'risuai.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    createChunkStore(db, { threshold: 256 })
    const appDataStore = createAppDataStore(db)
    appDataStore.replaceFromProjection({
        characters: [{
            chaId: 'character-1',
            name: 'Worker',
            chats: [{
                id: 'chat-1',
                name: 'Background snapshot',
                message: Array.from({ length: 20 }, (_, index) => ({
                    chatId: `message-${index}`,
                    role: index % 2 ? 'char' : 'user',
                    data: `payload-${index}`.repeat(20),
                })),
            }],
        }],
    })
    db.close()
    return dbPath
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory =>
        rm(directory, { recursive: true, force: true })))
})

describe('relational snapshot worker', () => {
    it('creates a compatible chunked snapshot and rotates it by count', async () => {
        const dbPath = await createFixture()
        const options = {
            dbPath,
            prefix: 'database/dbbackup-',
            maxCount: 1,
            maxBytes: 1024 * 1024,
            chunkThreshold: 256,
        }

        const first = createRelationalSnapshot(options)
        const second = createRelationalSnapshot(options)

        const db = new Database(dbPath)
        const chunkStore = createChunkStore(db, { threshold: 256 })
        const rows = db.prepare(`
          SELECT key FROM kv WHERE key LIKE 'database/dbbackup-%'
        `).all() as Array<{ key: string }>
        expect(rows).toHaveLength(1)
        expect(rows[0].key).toBe(second.key)
        expect(second.trim.removed).toBe(1)
        const decoded = await decodeRisuSave(chunkStore.getValue(second.key))
        expect(decoded.characters[0].chats[0].message).toHaveLength(20)
        expect(db.prepare(`
          SELECT COUNT(*) AS count FROM bookmark_snapshots
        `).get()).toEqual({ count: 1 })
        expect(first.logicalBytes).toBeGreaterThan(0)
        db.close()
    })
})

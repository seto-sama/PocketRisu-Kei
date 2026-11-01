// @vitest-environment node
import { openDatabase } from './sqlite.cjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import appDataStorePkg from './appDataStore.cjs'
import bookmarkStorePkg from './bookmarkStore.cjs'
import chunkStorePkg from './chunkStore.cjs'
import snapshotWorkerPkg from './snapshotWorker.cjs'
import risuSavePkg from './utils/risuSave.cjs'

const { createAppDataStore } = appDataStorePkg as any
const { createChunkStore } = chunkStorePkg as any
const { createBookmarkStore } = bookmarkStorePkg as any
const { createRelationalSnapshot, trimSnapshots } = snapshotWorkerPkg as any
const { decodeRisuSave } = risuSavePkg as any
const directories: string[] = []

async function createFixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'snapshot-worker-'))
    directories.push(directory)
    const dbPath = path.join(directory, 'risuai.db')
    const db = openDatabase(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`
      CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    createChunkStore(db)
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
    it('creates a compatible snapshot and rotates it by count', async () => {
        const dbPath = await createFixture()
        const options = {
            dbPath,
            prefix: 'database/dbbackup-',
            maxCount: 1,
            maxBytes: 1024 * 1024,
        }

        const first = createRelationalSnapshot(options)
        const second = createRelationalSnapshot(options)

        const db = openDatabase(dbPath)
        const chunkStore = createChunkStore(db)
        const rows = db.prepare(`
          SELECT key FROM kv WHERE key LIKE 'database/dbbackup-%'
        `).all() as Array<{ key: string }>
        expect(rows).toHaveLength(1)
        expect(rows[0].key).toBe(second.key)
        expect(second.trim.removed).toBe(1)
        const decoded = await decodeRisuSave(chunkStore.getValue(second.key))
        expect(decoded.characters[0].chats[0].message).toHaveLength(20)
        const bookmarkStore = createBookmarkStore(db)
        expect(bookmarkStore.restoreSnapshot(first.key)).toBe(false)
        expect(bookmarkStore.restoreSnapshot(second.key)).toBe(true)
        db.close()
    })

    it('counts a chunk repeated within one snapshot once against the byte limit', async () => {
        const dbPath = await createFixture()
        const db = openDatabase(dbPath)
        const chunkStore = createChunkStore(db, { threshold: 256 })
        createBookmarkStore(db)
        const keys = ['database/dbbackup-2.bin', 'database/dbbackup-1.bin']
        // Uniform bytes produce repeated chunks, so physical cost is below logical size.
        const values = [Buffer.alloc(256 * 1024, 7), Buffer.alloc(5000, 3)]
        keys.forEach((key, index) => chunkStore.putValue(key, values[index]))
        const budget = chunkStore.keySetPhysicalCost(keys)
        expect(budget).toBeLessThan(values[0].length)

        trimSnapshots(db, chunkStore, 'database/dbbackup-', 10, budget)

        keys.forEach((key, index) => expect(chunkStore.getValue(key)).toEqual(values[index]))
        db.close()
    })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, vi } from 'vitest'

const directory = mkdtempSync(join(tmpdir(), 'pocketrisu-server-tests-'))
const require = createRequire(import.meta.url)
const databases = new Set<DatabaseSync>()

function trackDatabases(...stores: Array<{ db?: DatabaseSync, requestDb?: DatabaseSync, systemDb?: DatabaseSync }>) {
    for (const store of stores) {
        for (const db of [store.db, store.requestDb, store.systemDb]) {
            if (db) databases.add(db)
        }
    }
}

function cleanup() {
    for (const db of databases) {
        if (db.isOpen) db.close()
    }
    rmSync(directory, { recursive: true, force: true })
}

// Vitest imports and CommonJS require use separate caches. Initialize both under
// a temporary cwd, then restore cwd for source paths and subprocess tests.
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory)
const sqliteTmpdir = process.env.SQLITE_TMPDIR
try {
    trackDatabases((await import('./server/db.cjs')).default, require('./server/db.cjs'))
    trackDatabases((await import('./server/logs/logDatabases.cjs')).default, require('./server/logs/logDatabases.cjs'))
    trackDatabases((await import('./server/revenant/persistence/connection.cjs')).default,
        require('./server/revenant/persistence/connection.cjs'))
    await import('./server/revenant/generationJournal.cjs')
    require('./server/revenant/generationJournal.cjs')
} catch (error) {
    cleanup()
    throw error
} finally {
    cwd.mockRestore()
    if (sqliteTmpdir === undefined) delete process.env.SQLITE_TMPDIR
    else process.env.SQLITE_TMPDIR = sqliteTmpdir
}

afterAll(cleanup)

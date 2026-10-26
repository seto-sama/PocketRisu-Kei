import { resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import database from './db.cjs'
import logs from './logs/logDatabases.cjs'
import generation from './revenant/persistence/connection.cjs'
import journal from './revenant/generationJournal.cjs'

it('keeps imported databases and journals outside the working save directory', () => {
    const require = createRequire(import.meta.url)
    const saveDirectory = resolve('save')
    const paths = [
        ...[
            database.db, logs.requestDb, logs.systemDb, generation.db,
            require('./db.cjs').db,
            require('./logs/logDatabases.cjs').requestDb,
            require('./logs/logDatabases.cjs').systemDb,
            require('./revenant/persistence/connection.cjs').db,
        ]
            .flatMap(db => db.prepare('PRAGMA database_list').all().map(row => row.file))
            .filter(Boolean),
        journal.generationJournalStore.revenantDir,
        require('./revenant/generationJournal.cjs').generationJournalStore.revenantDir,
    ]

    for (const path of paths) {
        expect(path).not.toBe(saveDirectory)
        expect(path.startsWith(saveDirectory + sep)).toBe(false)
    }
})

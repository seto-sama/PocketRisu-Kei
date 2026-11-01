import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { isBusyError, openDatabase, withTransaction } from './sqlite.cjs'

describe('sqlite helpers', () => {
    const databases: DatabaseSync[] = []
    const directories: string[] = []

    afterEach(() => {
        for (const database of databases.splice(0)) database.close()
        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('recognizes a locked database as a busy error', () => {
        const directory = mkdtempSync(join(tmpdir(), 'risu-sqlite-error-'))
        directories.push(directory)
        const path = join(directory, 'locked.db')
        const writer = openDatabase(path)
        const contender = openDatabase(path, { timeout: 0 })
        databases.push(writer, contender)
        writer.exec('CREATE TABLE values_table (value TEXT)')
        writer.exec('BEGIN EXCLUSIVE')

        let error: unknown
        try {
            contender.prepare('INSERT INTO values_table VALUES (?)').run('value')
        } catch (caught) {
            error = caught
        }
        expect(isBusyError(error)).toBe(true)

        writer.exec('ROLLBACK')
    })

    it('rolls back a nested transaction to its savepoint only', () => {
        const db = openDatabase(':memory:')
        databases.push(db)
        db.exec('CREATE TABLE items (name TEXT)')
        const insert = db.prepare('INSERT INTO items VALUES (?)')

        withTransaction(db, () => {
            insert.run('outer')
            expect(() => withTransaction(db, () => {
                insert.run('inner')
                throw new Error('inner failure')
            })).toThrow('inner failure')
        })

        expect(db.prepare('SELECT name FROM items').all().map(row => row.name)).toEqual(['outer'])
        expect(db.isTransaction).toBe(false)
    })
})

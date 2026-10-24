import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const Database = createRequire(import.meta.url)('./sqlite.cjs') as new (path: string) => {
    close(): void
    exec(sql: string): void
    prepare(sql: string): { run(...values: unknown[]): unknown }
}

describe('SQLite error normalization', () => {
    const databases: Array<InstanceType<typeof Database>> = []
    const directories: string[] = []

    afterEach(() => {
        for (const database of databases.splice(0)) database.close()
        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('exposes a stable, retryable API code for a locked database', () => {
        const directory = mkdtempSync(join(tmpdir(), 'risu-sqlite-error-'))
        directories.push(directory)
        const path = join(directory, 'locked.db')
        const writer = new Database(path)
        const contender = new Database(path)
        databases.push(writer, contender)
        writer.exec('CREATE TABLE values_table (value TEXT)')
        contender.exec('PRAGMA busy_timeout = 0')
        writer.exec('BEGIN EXCLUSIVE')

        expect(() => contender.prepare('INSERT INTO values_table VALUES (?)').run('value'))
            .toThrow(expect.objectContaining({ code: 'DATABASE_LOCKED', statusCode: 503 }))

        writer.exec('ROLLBACK')
    })
})

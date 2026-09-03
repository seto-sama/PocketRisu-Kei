import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const {
    BACKUP_NOTE_MAX_LENGTH,
    BACKUP_NOTES_FILENAME,
    deleteBackupNote,
    getBackupNote,
    readBackupNotes,
    setBackupNote,
} = require('./backupNotes.cjs')

const directories: string[] = []

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory() {
    const directory = mkdtempSync(join(tmpdir(), 'risu-backup-notes-'))
    directories.push(directory)
    return directory
}

describe('backup notes sidecar', () => {
    it('stores notes by backup kind and identifier', () => {
        const directory = temporaryDirectory()

        setBackupNote(directory, 'server', 'risu-backup-1.bin', '  before migration  ')
        setBackupNote(directory, 'manual', 'dbbackup-1.bin', 'manual checkpoint')

        const notes = readBackupNotes(directory)
        expect(getBackupNote(notes, 'server', 'risu-backup-1.bin')).toBe('before migration')
        expect(getBackupNote(notes, 'manual', 'dbbackup-1.bin')).toBe('manual checkpoint')
        expect(JSON.parse(readFileSync(join(directory, BACKUP_NOTES_FILENAME), 'utf-8')).version).toBe(1)
    })

    it('clears blank notes and limits their length', () => {
        const directory = temporaryDirectory()
        const id = 'database/dbbackup-1.bin'

        expect(setBackupNote(directory, 'snapshot', id, 'x'.repeat(BACKUP_NOTE_MAX_LENGTH + 20))).toHaveLength(BACKUP_NOTE_MAX_LENGTH)
        expect(setBackupNote(directory, 'snapshot', id, '   ')).toBe('')
        expect(getBackupNote(readBackupNotes(directory), 'snapshot', id)).toBe('')
    })

    it('deletes only the requested note', () => {
        const directory = temporaryDirectory()
        setBackupNote(directory, 'server', 'risu-backup-1.bin', 'one')
        setBackupNote(directory, 'server', 'risu-backup-2.bin', 'two')

        deleteBackupNote(directory, 'server', 'risu-backup-1.bin')

        const notes = readBackupNotes(directory)
        expect(getBackupNote(notes, 'server', 'risu-backup-1.bin')).toBe('')
        expect(getBackupNote(notes, 'server', 'risu-backup-2.bin')).toBe('two')
    })
})

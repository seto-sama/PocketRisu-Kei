const path = require('path');
const { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('fs');

const BACKUP_NOTES_FILENAME = '.risu-backup-notes.json';
const BACKUP_NOTE_MAX_LENGTH = 200;

function notesPath(directory) {
    return path.join(directory, BACKUP_NOTES_FILENAME);
}

function normalizeBackupNote(value) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, BACKUP_NOTE_MAX_LENGTH);
}

function backupNoteKey(kind, id) {
    return `${kind}:${id}`;
}

function readBackupNotes(directory) {
    try {
        const parsed = JSON.parse(readFileSync(notesPath(directory), 'utf-8'));
        if (!parsed || parsed.version !== 1 || typeof parsed.notes !== 'object' || Array.isArray(parsed.notes)) {
            return {};
        }
        const notes = {};
        for (const [key, value] of Object.entries(parsed.notes)) {
            const note = normalizeBackupNote(value);
            if (note) notes[key] = note;
        }
        return notes;
    } catch {
        return {};
    }
}

function writeBackupNotes(directory, notes) {
    mkdirSync(directory, { recursive: true });
    const target = notesPath(directory);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify({ version: 1, notes }, null, 2) + '\n', 'utf-8');
        renameSync(temporary, target);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

function getBackupNote(notes, kind, id) {
    return normalizeBackupNote(notes[backupNoteKey(kind, id)]);
}

function setBackupNote(directory, kind, id, value) {
    const notes = readBackupNotes(directory);
    const key = backupNoteKey(kind, id);
    const note = normalizeBackupNote(value);
    if (note) notes[key] = note;
    else delete notes[key];
    writeBackupNotes(directory, notes);
    return note;
}

function deleteBackupNote(directory, kind, id) {
    deleteBackupNotes(directory, kind, [id]);
}

function deleteBackupNotes(directory, kind, ids) {
    const notes = readBackupNotes(directory);
    let changed = false;
    for (const id of ids) {
        const key = backupNoteKey(kind, id);
        if (!(key in notes)) continue;
        delete notes[key];
        changed = true;
    }
    if (!changed) return;
    writeBackupNotes(directory, notes);
}

module.exports = {
    BACKUP_NOTE_MAX_LENGTH,
    BACKUP_NOTES_FILENAME,
    deleteBackupNote,
    deleteBackupNotes,
    getBackupNote,
    normalizeBackupNote,
    readBackupNotes,
    setBackupNote,
};

'use strict';

const path = require('path');
const { existsSync, mkdirSync, writeFileSync } = require('fs');

const BACKUP_FILENAME_REGEX = /^risu-backup-\d+\.bin$/;

function createBackupLocation({ savePath, kvGet }) {
    // Keep backups outside save/ to avoid bloating updater copies.
    const DEFAULT_BACKUPS_DIR = path.join(process.cwd(), "backups");
    const BACKUP_PATH_CONFIG_KEY = 'config/server-backup-path';

    // The updater runs without SQLite dependencies and needs this marker to
    // preserve a custom backup directory during in-place updates.
    const BACKUP_PATH_MARKER = path.join(savePath, '__backup_path');

    function readBackupsDirConfig() {
        try {
            const raw = kvGet(BACKUP_PATH_CONFIG_KEY);
            if (!raw) return DEFAULT_BACKUPS_DIR;
            const text = Buffer.from(raw).toString('utf-8').trim();
            return text || DEFAULT_BACKUPS_DIR;
        } catch { return DEFAULT_BACKUPS_DIR; }
    }

    function writeBackupPathMarker(absPath) {
        try {
            writeFileSync(BACKUP_PATH_MARKER, absPath, 'utf-8');
        } catch {
            // Best-effort; without the marker the updater keeps only `backups`.
        }
    }

    const backupState = {
        backupsDir: readBackupsDirConfig(),
    };
    if(!existsSync(backupState.backupsDir)){
        try { mkdirSync(backupState.backupsDir, { recursive: true }); }
        catch { backupState.backupsDir = DEFAULT_BACKUPS_DIR; mkdirSync(backupState.backupsDir, { recursive: true }); }
    }
    writeBackupPathMarker(backupState.backupsDir);

    return {
        DEFAULT_BACKUPS_DIR,
        BACKUP_PATH_CONFIG_KEY,
        BACKUP_FILENAME_REGEX,
        backupState,
        writeBackupPathMarker,
    };
}

module.exports = { createBackupLocation };

'use strict';

const path = require('path');
const { existsSync, mkdirSync, writeFileSync } = require('fs');

const BACKUP_FILENAME_REGEX = /^risu-backup-\d+\.bin$/;

// Server-side backup directory (outside save/ to avoid bloating updater copies).
// Configurable at runtime via the kv key `config/server-backup-path`. When the
// user changes the path the old directory is left in place (existing backups
// stay where they were); only future backups land at the new path.
function createBackupLocation({ savePath, kvGet }) {
    const DEFAULT_BACKUPS_DIR = path.join(process.cwd(), "backups");
    const BACKUP_PATH_CONFIG_KEY = 'config/server-backup-path';

    // Plaintext marker the updater reads to preserve a custom in-tree backup dir
    // during in-place updates. KV lives inside the SQLite DB so the updater (which
    // runs without npm deps) can't read it; this marker bridges that gap.
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

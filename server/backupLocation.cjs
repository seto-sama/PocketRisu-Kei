'use strict';

const path = require('path');
const { existsSync, mkdirSync } = require('fs');

const BACKUP_FILENAME_REGEX = /^risu-backup-\d+\.bin$/;

function createBackupLocation({ kvGet }) {
    // Keep backups outside save/ so the database folder stays small.
    const DEFAULT_BACKUPS_DIR = path.join(process.cwd(), "backups");
    const BACKUP_PATH_CONFIG_KEY = 'config/server-backup-path';

    function readBackupsDirConfig() {
        try {
            const raw = kvGet(BACKUP_PATH_CONFIG_KEY);
            if (!raw) return DEFAULT_BACKUPS_DIR;
            const text = Buffer.from(raw).toString('utf-8').trim();
            return text || DEFAULT_BACKUPS_DIR;
        } catch { return DEFAULT_BACKUPS_DIR; }
    }

    const backupState = {
        backupsDir: readBackupsDirConfig(),
    };
    if(!existsSync(backupState.backupsDir)){
        try { mkdirSync(backupState.backupsDir, { recursive: true }); }
        catch { backupState.backupsDir = DEFAULT_BACKUPS_DIR; mkdirSync(backupState.backupsDir, { recursive: true }); }
    }

    return {
        DEFAULT_BACKUPS_DIR,
        BACKUP_PATH_CONFIG_KEY,
        BACKUP_FILENAME_REGEX,
        backupState,
    };
}

module.exports = { createBackupLocation };

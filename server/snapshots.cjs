'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { encodeRisuSaveLegacy } = require('./utils/risuSave.cjs');
const { exportPromptPresetSelection } = require('../shared/promptPresetSelection.mjs');
const { createSnapshotKey, trimSnapshots } = require('./snapshotWorker.cjs');

// Snapshots live as `database/dbbackup-{ts}.bin` keys inside the kv table.
// They're created on every successful persist (with a cooldown) and rotated
// to fit user-configured count/size limits — see SNAPSHOT_LIMIT_* below.
const DB_BACKUP_PREFIX = 'database/dbbackup-';
const SNAPSHOT_LIMIT_COUNT_KEY = 'config/snapshot-max-count';
const SNAPSHOT_LIMIT_BYTES_KEY = 'config/snapshot-max-bytes';
const SNAPSHOT_LIMIT_DEFAULT_COUNT = 20;
const SNAPSHOT_LIMIT_DEFAULT_BYTES = 500 * 1024 * 1024;
// Safety bounds to keep a stray PUT from making the system unusable.
const SNAPSHOT_LIMIT_MIN_COUNT = 1;
const SNAPSHOT_LIMIT_MAX_COUNT = 100;
const SNAPSHOT_LIMIT_MIN_BYTES = 10 * 1024 * 1024;
const SNAPSHOT_LIMIT_MAX_BYTES = 50 * 1024 * 1024 * 1024;
const BACKUP_INTERVAL_MS = process.env.POCKETRISU_BACKUP_INTERVAL_MS
    ? Number(process.env.POCKETRISU_BACKUP_INTERVAL_MS)
    : 5 * 60 * 1000;

function createSnapshotService({
    sqliteDb,
    chunkStore,
    kvGet,
    kvSetChunked,
    kvDel,
    appDataStore,
    bookmarkStore,
    logger,
}) {
    let lastBackupTime = null;
    let backupRotationScheduled = false;

    function readSnapshotConfigInt(key, fallback, min, max) {
        try {
            const raw = kvGet(key);
            if (!raw) return fallback;
            const n = parseInt(Buffer.from(raw).toString('utf-8').trim(), 10);
            if (!Number.isFinite(n)) return fallback;
            return Math.min(max, Math.max(min, n));
        } catch { return fallback; }
    }

    function getSnapshotLimits() {
        return {
            maxCount: readSnapshotConfigInt(
                SNAPSHOT_LIMIT_COUNT_KEY, SNAPSHOT_LIMIT_DEFAULT_COUNT,
                SNAPSHOT_LIMIT_MIN_COUNT, SNAPSHOT_LIMIT_MAX_COUNT,
            ),
            maxBytes: readSnapshotConfigInt(
                SNAPSHOT_LIMIT_BYTES_KEY, SNAPSHOT_LIMIT_DEFAULT_BYTES,
                SNAPSHOT_LIMIT_MIN_BYTES, SNAPSHOT_LIMIT_MAX_BYTES,
            ),
        };
    }

    function deleteSnapshotStateRows(key) {
        kvDel(key);
        bookmarkStore.deleteSnapshot(key);
    }

    // Same rotation the background worker runs after each persist: newest
    // first, always keep the most recent, count shared chunks once.
    function trimSnapshotsToLimits() {
        const { maxCount, maxBytes } = getSnapshotLimits();
        return trimSnapshots(sqliteDb, chunkStore, DB_BACKUP_PREFIX, maxCount, maxBytes);
    }

    const createSnapshotState = sqliteDb.transaction(() => {
        if (!appDataStore.getState().initialized) {
            throw new Error('Cannot create snapshot: relational database is missing');
        }
        const backupKey = createSnapshotKey(sqliteDb, DB_BACKUP_PREFIX);
        const projection = appDataStore.exportProjection({ includeMessages: true });
        bookmarkStore.projectDatabaseCompatibility(projection);
        kvSetChunked(backupKey, Buffer.from(encodeRisuSaveLegacy(
            exportPromptPresetSelection(projection),
        )));
        if (!kvGet(backupKey)) throw new Error('Cannot create snapshot: database blob is missing');
        bookmarkStore.saveSnapshot(backupKey);
        trimSnapshotsToLimits();
        return backupKey;
    });

    function createBackupAndRotate() {
        const now = Date.now();
        if (lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS) {
            return;
        }
        lastBackupTime = now;

        createSnapshotState();
    }

    function scheduleBackupAndRotate() {
        const now = Date.now();
        if (backupRotationScheduled
            || (lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS)) {
            return;
        }
        backupRotationScheduled = true;
        lastBackupTime = now;
        setImmediate(() => {
            const limits = getSnapshotLimits();
            const worker = new Worker(path.join(__dirname, 'snapshotWorker.cjs'), {
                workerData: {
                    dbPath: path.join(process.cwd(), 'save', 'risuai.db'),
                    prefix: DB_BACKUP_PREFIX,
                    maxCount: limits.maxCount,
                    maxBytes: limits.maxBytes,
                },
            });
            let reported = false;
            worker.once('message', message => {
                reported = true;
                if (!message?.ok) {
                    lastBackupTime = null;
                    logger.warn('[Snapshot] Worker rotation failed:', message?.error ?? 'unknown error');
                }
            });
            worker.once('error', error => {
                reported = true;
                lastBackupTime = null;
                logger.warn('[Snapshot] Worker failed:', error);
            });
            worker.once('exit', code => {
                if (!reported && code !== 0) {
                    lastBackupTime = null;
                    logger.warn(`[Snapshot] Worker exited with code ${code}`);
                }
                backupRotationScheduled = false;
            });
        });
    }

    return {
        DB_BACKUP_PREFIX,
        SNAPSHOT_LIMIT_COUNT_KEY,
        SNAPSHOT_LIMIT_BYTES_KEY,
        SNAPSHOT_LIMIT_DEFAULT_COUNT,
        SNAPSHOT_LIMIT_DEFAULT_BYTES,
        SNAPSHOT_LIMIT_MIN_COUNT,
        SNAPSHOT_LIMIT_MAX_COUNT,
        SNAPSHOT_LIMIT_MIN_BYTES,
        SNAPSHOT_LIMIT_MAX_BYTES,
        getSnapshotLimits,
        deleteSnapshotStateRows,
        trimSnapshotsToLimits,
        createBackupAndRotate,
        scheduleBackupAndRotate,
    };
}

module.exports = { createSnapshotService };

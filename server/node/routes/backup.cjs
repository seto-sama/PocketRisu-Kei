'use strict';

const { db: sqliteDb, kvList, snapshotSetFootprint, kvSize, kvGet, kvSet, kvDel, kvDelPrefix, clearEntities, checkpointWal, kvListWithSizes } = require('../db.cjs');
const path = require('path');
const fs = require('fs/promises');
const { existsSync, mkdirSync } = require('fs');
const { decodeRisuSave, normalizeJSON, encodeRisuSaveLegacy } = require('../utils.cjs');
const { createBackupRestoreService, restoreMissingAssetsFromBackupFile } = require('../dataRestore/index.cjs');
const { logger } = require('../logs/logs.cjs');
const { buildSettingsBackupPlan } = require('../settingsBackup.cjs');
const { STORED_ASSET_PREFIX, collectDatabaseAssetBasenames, assetBasename: statsBasename } = require('../assetReferences.cjs');
const { normalizeBackupNote, setBackupNote, readBackupNotes, getBackupNote, deleteBackupNote } = require('../backupNotes.cjs');

function installBackupRoutes(app, {
    deleteSnapshotStateRows,
    DB_BACKUP_PREFIX,
    storageState,
    DB_HEX_KEY,
    saveTimers,
    backupState,
    BACKUP_FILENAME_REGEX,
    normalizeLegacyDatabaseProjection,
    bookmarkStore,
    appDataStore,
    createBackupAndRotate,
    savePath,
    inlayDir,
    inlayMigrationMarker,
    flushPendingDb,
    normalizeInlayExt,
    isSafeInlayId,
    decodeDataUri,
    ensureInlayDir,
    normalizeColdStorageStorageKey,
    parseColdStorageJsonBuffer,
    encodeColdStorageCanonicalBuffer,
    ensureCanonicalStorage,
    checkAuth,
    listInlayFiles,
    getInlaySidecarPath,
    listColdStorageBackupEntries,
    requireSyncClientId,
    queueStorageOperation,
    broadcastDatabaseInvalidated,
    broadcastBookmarksInvalidated,
    estimateServerBackupSize,
    getSnapshotLimits,
    SNAPSHOT_LIMIT_MIN_COUNT,
    SNAPSHOT_LIMIT_MAX_COUNT,
    SNAPSHOT_LIMIT_MIN_BYTES,
    SNAPSHOT_LIMIT_MAX_BYTES,
    SNAPSHOT_LIMIT_DEFAULT_COUNT,
    SNAPSHOT_LIMIT_DEFAULT_BYTES,
    SNAPSHOT_LIMIT_COUNT_KEY,
    SNAPSHOT_LIMIT_BYTES_KEY,
    trimSnapshotsToLimits,
    refreshCanonicalDatabaseCache,
    DEFAULT_BACKUPS_DIR,
    BACKUP_PATH_CONFIG_KEY,
    writeBackupPathMarker,
}) {
    const deleteSnapshotState = sqliteDb.transaction(deleteSnapshotStateRows);

    function snapshotUsage() {
        const keys = kvList(DB_BACKUP_PREFIX);
        const bytes = snapshotSetFootprint(keys);
        let logicalBytes = 0;
        for (const k of keys) {
            logicalBytes += (kvSize(k) || 0);
        }
        return { count: keys.length, bytes, logicalBytes };
    }

    function invalidateDbCache() {
        delete storageState.dbCache[DB_HEX_KEY];
        storageState.fullChatStore = null;
        if (saveTimers[DB_HEX_KEY]) {
            clearTimeout(saveTimers[DB_HEX_KEY]);
            delete saveTimers[DB_HEX_KEY];
        }
        storageState.dbEtag = null;
    }

    const MANAGED_BACKUP_PATH_ROOTS = new Set(['server', 'dist', 'scripts', 'bin', 'node_modules', '.update-tmp']);

    function isManagedBackupPath(absPath) {
        const rel = path.relative(process.cwd(), absPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
        if (!rel) return true;
        return MANAGED_BACKUP_PATH_ROOTS.has(rel.split(path.sep)[0]);
    }

    const MANUAL_SNAPSHOT_FILENAME_REGEX = /^dbbackup-\d+\.bin$/;

    const BACKUP_SCHEDULE_KEY = 'config/backup-schedule';

    const DEFAULT_BACKUP_SCHEDULE = Object.freeze({
        enabled: false,
        serverDays: 0,
        snapshotDays: 0,
    });

    function getManualSnapshotsDir() {
        return path.join(backupState.backupsDir, 'snapshot');
    }

    function getBackupNotesDir() {
        // File-backed backup notes travel with the configured backup directory and
        // are never part of a database restore.
        return backupState.backupsDir;
    }

    function isValidBackupNoteTarget(kind, id) {
        if (kind === 'server') return BACKUP_FILENAME_REGEX.test(id);
        if (kind === 'manual') return MANUAL_SNAPSHOT_FILENAME_REGEX.test(id);
        return false;
    }

    async function backupNoteTargetExists(kind, id) {
        const directory = kind === 'manual' ? getManualSnapshotsDir() : backupState.backupsDir;
        try {
            await fs.access(path.join(directory, id));
            return true;
        } catch {
            return false;
        }
    }

    function makeManualSnapshotFilename(now = Date.now()) {
        let tick = Math.round(now / 100);
        let filename = `dbbackup-${tick}.bin`;
        while (existsSync(path.join(getManualSnapshotsDir(), filename))) {
            tick += 1;
            filename = `dbbackup-${tick}.bin`;
        }
        return filename;
    }

    function clampBackupScheduleDays(value, fallback) {
        const days = Math.floor(Number(value));
        if (!Number.isFinite(days)) return fallback;
        return Math.min(365, Math.max(0, days));
    }

    function normalizeBackupSchedule(raw = {}) {
        const serverDays = clampBackupScheduleDays(raw.serverDays, DEFAULT_BACKUP_SCHEDULE.serverDays);
        const snapshotDays = clampBackupScheduleDays(raw.snapshotDays, DEFAULT_BACKUP_SCHEDULE.snapshotDays);
        return {
            enabled: !!raw.enabled,
            serverDays,
            snapshotDays,
            serverEnabled: serverDays > 0,
            snapshotEnabled: snapshotDays > 0,
        };
    }

    function readBackupSchedule() {
        try {
            const raw = kvGet(BACKUP_SCHEDULE_KEY);
            if (!raw) return { ...DEFAULT_BACKUP_SCHEDULE };
            return normalizeBackupSchedule(JSON.parse(Buffer.from(raw).toString('utf-8')));
        } catch {
            return { ...DEFAULT_BACKUP_SCHEDULE };
        }
    }

    const BACKUP_IMPORT_MAX_BYTES = Number(process.env.RISU_BACKUP_IMPORT_MAX_BYTES ?? '0');

    const BACKUP_ENTRY_NAME_MAX_BYTES = 1024;

    const BACKUP_DISK_HEADROOM = 2;

    const BACKUP_NDJSON_HEARTBEAT_MS = Math.max(
        100,
        Number(process.env.BACKUP_NDJSON_HEARTBEAT_MS ?? '5000') || 5000,
    );

    let importInProgress = false;

    async function checkDiskSpace(requiredBytes) {
        try {
            const saveDir = path.join(process.cwd(), 'save');
            const stats = await fs.statfs(saveDir);
            const availableBytes = stats.bavail * stats.bsize;
            return { ok: availableBytes >= requiredBytes, available: availableBytes };
        } catch {
            // statfs unavailable on this platform — skip check
            return { ok: true, available: -1 };
        }
    }

    function encodeBackupEntry(name, data) {
        const encodedName = Buffer.from(name, 'utf-8');
        const nameLength = Buffer.allocUnsafe(4);
        nameLength.writeUInt32LE(encodedName.length, 0);
        const dataLength = Buffer.allocUnsafe(4);
        dataLength.writeUInt32LE(data.length, 0);
        return Buffer.concat([nameLength, encodedName, dataLength, data]);
    }

    async function prepareImportedDatabaseProjection(raw) {
        const decoded = await decodeRisuSave(Buffer.from(raw));
        const prepared = normalizeJSON(decoded);
        if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
            throw new TypeError('Imported database projection must be an object');
        }

        return {
            install() {
                const { database, coldRestoreResult } =
                    normalizeLegacyDatabaseProjection(prepared);
                bookmarkStore.replaceDatabaseCompatibility(database);
                const installed = appDataStore.replaceFromProjection(database, {
                    expectedRevision: appDataStore.getState().revision,
                });
                return {
                    ...installed,
                    coldStorageFailed: coldRestoreResult.failed,
                };
            },
        };
    }

    function createPreReplacementSnapshot() {
        if (appDataStore.getState().initialized) createBackupAndRotate();
    }

    const {
        importBackupFromSource,
    } = createBackupRestoreService({
        savePath,
        inlayDir,
        inlayMigrationMarker,
        sqliteDb,
        kvGet,
        kvSet,
        kvDel,
        kvDelPrefix,
        clearEntities,
        checkpointWal,
        flushPendingDb,
        createBackupAndRotate: createPreReplacementSnapshot,
        invalidateDbCache,
        prepareDatabaseProjection: prepareImportedDatabaseProjection,
        normalizeInlayExt,
        isSafeInlayId,
        decodeDataUri,
        ensureInlayDir,
        normalizeColdStorageStorageKey,
        parseColdStorageJsonBuffer,
        encodeColdStorageCanonicalBuffer,
        logger,
        maxEntryNameBytes: BACKUP_ENTRY_NAME_MAX_BYTES,
    });

    async function createSettingsBackupPlan(includeModuleAssets = true) {
        const { withExportColorSchemes } = await import('../../shared/colorScheme.js');
        await ensureCanonicalStorage();
        const databaseValue = appDataStore.getState().initialized
            ? Buffer.from(encodeRisuSaveLegacy(
                appDataStore.exportProjection({ includeMessages: true }),
            ))
            : null;
        return buildSettingsBackupPlan({
            databaseValue,
            assetRows: kvListWithSizes(STORED_ASSET_PREFIX),
            decodeDatabase: decodeRisuSave,
            encodeDatabase: (database) => encodeRisuSaveLegacy(withExportColorSchemes(database), 'compression'),
            includeModuleAssets,
        });
    }

    async function createCompatibleDatabaseValue({ exportColors = false } = {}) {
        await ensureCanonicalStorage();
        if (!appDataStore.getState().initialized) return null;
        const database = appDataStore.exportProjection({ includeMessages: true });
        bookmarkStore.projectDatabaseCompatibility(database);
        // Internal snapshots retain canonical fields; only portable backups get aliases.
        const output = exportColors
            ? (await import('../../shared/colorScheme.js')).withExportColorSchemes(database)
            : database;
        return Buffer.from(encodeRisuSaveLegacy(output, 'compression'));
    }

    app.get('/api/backup/export/settings-estimate', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            await flushPendingDb();
            const plan = await createSettingsBackupPlan();
            if (!plan) return res.status(500).json({ error: 'database.bin missing' });
            res.json(plan.breakdown);
        } catch (error) { next(error); }
    });

    app.get('/api/backup/export', async (req, res, next) => {
        if(!await checkAuth(req, res)){ return; }
        try {
            // ?target=upstream excludes NodeOnly-only inlay namespaces (inlay/,
            // inlay_sidecar/, inlay_meta/). Their entry names contain a slash,
            // which upstream RisuAI's import treats as a path under assets/ and
            // fails with ENOENT. The export becomes lossy on inlay images but
            // imports cleanly into upstream.
            const target = req.query.target === 'upstream' ? 'upstream' : 'nodeonly';
            const settingsOnly = req.query.mode === 'settings';
            const includeModuleAssets = req.query.moduleAssets !== '0';
            // Flush any pending patches to ensure export includes latest data
            await flushPendingDb();

            const settingsPlan = settingsOnly
                ? await createSettingsBackupPlan(includeModuleAssets)
                : null;
            if (settingsOnly && !settingsPlan) {
                return res.status(500).json({ error: 'database.bin missing' });
            }

            const skipInlay = settingsOnly || target === 'upstream';
            const inlayFiles = skipInlay ? [] : await listInlayFiles();
            const inlayEntries = await Promise.all(inlayFiles.map(async (entry) => {
                const stat = await fs.stat(entry.filePath);
                return {
                    kind: 'file',
                    sourcePath: entry.filePath,
                    backupName: `inlay/${entry.id}.${entry.ext}`,
                    sortKey: `inlay/${entry.id}`,
                    size: stat.size,
                };
            }));
            const sidecarEntries = await Promise.all(inlayFiles.map(async (entry) => {
                const sidecarPath = getInlaySidecarPath(entry.id);
                try {
                    const stat = await fs.stat(sidecarPath);
                    return {
                        kind: 'sidecar',
                        sourcePath: sidecarPath,
                        backupName: `inlay_sidecar/${entry.id}`,
                        sortKey: `inlay_sidecar/${entry.id}`,
                        size: stat.size,
                    };
                } catch {
                    return null;
                }
            }));
            const inlayMetaEntries = skipInlay ? [] : kvListWithSizes('inlay_meta/').map((entry) => ({
                kind: 'kv',
                key: entry.key,
                backupName: entry.key,
                sortKey: entry.key,
                size: entry.size,
            }));
            const namespacedEntries = [
                ...(settingsPlan?.includedAssets ?? kvListWithSizes(STORED_ASSET_PREFIX))
                    .map((entry) => ({
                        kind: 'kv',
                        key: entry.key,
                        backupName: path.basename(entry.key),
                        sortKey: entry.key,
                        size: entry.size,
                    })),
                ...(settingsOnly ? [] : listColdStorageBackupEntries()),
                ...inlayMetaEntries,
                ...inlayEntries,
                ...sidecarEntries.filter(Boolean),
            ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
            const exportedDatabase = settingsPlan?.encodedDatabase
                ?? await createCompatibleDatabaseValue({ exportColors: true });
            const dbSize = exportedDatabase?.length ?? 0;
            const totalBytes = namespacedEntries.reduce((sum, entry) => {
                return sum + 8 + Buffer.byteLength(entry.backupName, 'utf-8') + entry.size;
            }, 0) + (dbSize ? 8 + Buffer.byteLength('database.risudat', 'utf-8') + dbSize : 0);

            const filenameBase = settingsOnly ? 'risu-settings' : 'risu-backup';
            const filenameSuffix = settingsOnly ? '' : target === 'upstream' ? '-upstream' : '';
            res.setHeader('content-type', 'application/octet-stream');
            res.setHeader('content-disposition', `attachment; filename="${filenameBase}-${Date.now()}${filenameSuffix}.bin"`);
            res.setHeader('content-length', totalBytes);
            res.setHeader('x-risu-backup-assets', namespacedEntries.length);

            let closed = false;
            res.once('close', () => { closed = true; });

            function waitForDrain() {
                if (closed) return Promise.resolve();
                return new Promise(resolve => {
                    function done() {
                        res.removeListener('drain', done);
                        res.removeListener('close', done);
                        resolve();
                    }
                    res.once('drain', done);
                    res.once('close', done);
                });
            }

            for (const entry of namespacedEntries) {
                if (closed) break;
                const value = entry.kind === 'kv'
                    ? kvGet(entry.key)
                    : entry.kind === 'buffer'
                        ? entry.buffer
                        : await fs.readFile(entry.sourcePath);
                if (closed) break;
                if (value) {
                    const ok = res.write(encodeBackupEntry(entry.backupName, value));
                    if (!ok) {
                        await waitForDrain();
                        if (closed) break;
                    }
                }
            }

            if (!closed && dbSize) {
                const ok = res.write(encodeBackupEntry('database.risudat', exportedDatabase));
                if (!ok) {
                    await waitForDrain();
                }
            }
            if (!closed) res.end();
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/backup/import/prepare', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;
        try {
            if (importInProgress) {
                res.status(409).json({ error: 'Another import is already in progress' });
                return;
            }

            const size = Number(req.body?.size ?? 0);
            if (BACKUP_IMPORT_MAX_BYTES > 0 && size > BACKUP_IMPORT_MAX_BYTES) {
                res.status(413).json({ error: `Backup exceeds max allowed size (${BACKUP_IMPORT_MAX_BYTES} bytes)` });
                return;
            }

            if (size > 0) {
                const disk = await checkDiskSpace(size * BACKUP_DISK_HEADROOM);
                if (!disk.ok) {
                    res.status(507).json({
                        error: 'Insufficient disk space',
                        available: disk.available,
                        required: size * BACKUP_DISK_HEADROOM,
                    });
                    return;
                }
            }

            res.json({ ok: true });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/backup/import', async (req, res, next) => {
        if(!await checkAuth(req, res)){ return; }
        if (!requireSyncClientId(req, res)) return;

        if (importInProgress) {
            res.status(409).json({ error: 'Another import is already in progress' });
            return;
        }
        importInProgress = true;

        // Disable timeouts for large backup uploads
        const prevRequestTimeout = req.socket.server?.requestTimeout;
        req.socket.setTimeout(0);
        req.socket.setKeepAlive(true);
        if (req.socket.server) req.socket.server.requestTimeout = 0;

        // NDJSON streaming keeps the response socket alive during long
        // post-upload work (WAL checkpoint, cold-storage migration). Without it
        // a reverse proxy in front of the server can hit its response timeout
        // and bounce the request back to the client as 502 Bad Gateway.
        const wantsNdjson = String(req.headers['accept'] ?? '').includes('application/x-ndjson');
        let heartbeatTimer = null;

        try {
            const contentType = String(req.headers['content-type'] ?? '');
            if (contentType && !contentType.includes('application/x-risu-backup') && !contentType.includes('application/octet-stream')) {
                res.status(415).json({ error: 'Unsupported backup content-type' });
                return;
            }

            const contentLength = Number(req.headers['content-length'] ?? '0');
            if (BACKUP_IMPORT_MAX_BYTES > 0 && Number.isFinite(contentLength) && contentLength > BACKUP_IMPORT_MAX_BYTES) {
                res.status(413).json({ error: `Backup exceeds max allowed size (${BACKUP_IMPORT_MAX_BYTES} bytes)` });
                return;
            }

            if (wantsNdjson) {
                res.setHeader('content-type', 'application/x-ndjson');
                res.setHeader('cache-control', 'no-cache, no-transform');
                // Disable nginx response buffering so progress events flush immediately.
                res.setHeader('x-accel-buffering', 'no');
                res.flushHeaders();

                // Periodic keepalive — covers the post-stream phase (commit,
                // inlay dir swap, cold storage migration) where onProgress is silent.
                heartbeatTimer = setInterval(() => {
                    if (!res.writableEnded) res.write('{"type":"heartbeat"}\n');
                }, BACKUP_NDJSON_HEARTBEAT_MS);

                let lastProgressWrite = 0;
                const totalBytes = Number.isFinite(contentLength) ? contentLength : 0;
                const result = await queueStorageOperation(() => importBackupFromSource(req, {
                    maxBytes: BACKUP_IMPORT_MAX_BYTES,
                    totalBytes,
                    onProgress: (received, total) => {
                        const now = Date.now();
                        if (now - lastProgressWrite < 200) return;
                        lastProgressWrite = now;
                        res.write(JSON.stringify({ type: 'progress', bytes: received, totalBytes: total }) + '\n');
                    },
                }));
                broadcastDatabaseInvalidated(req, { allChats: true });
                broadcastBookmarksInvalidated(req);
                res.write(JSON.stringify({
                    type: 'done',
                    ok: true,
                    assetsRestored: result.assetsRestored,
                    coldStorageFailed: result.coldStorageFailed,
                }) + '\n');
                res.end();
            } else {
                const result = await queueStorageOperation(() => importBackupFromSource(req, {
                    maxBytes: BACKUP_IMPORT_MAX_BYTES,
                }));
                broadcastDatabaseInvalidated(req, { allChats: true });
                broadcastBookmarksInvalidated(req);
                res.json({
                    ok: true,
                    assetsRestored: result.assetsRestored,
                    coldStorageFailed: result.coldStorageFailed,
                });
            }
        } catch (error) {
            if (wantsNdjson && res.headersSent) {
                try {
                    res.write(JSON.stringify({
                        type: 'error',
                        message: error?.message || 'backup import failed',
                        ...(error?.code ? { code: error.code } : {}),
                    }) + '\n');
                    res.end();
                } catch (_) {}
            } else {
                next(error);
            }
        } finally {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            importInProgress = false;
            if (req.socket.server && prevRequestTimeout !== undefined) {
                req.socket.server.requestTimeout = prevRequestTimeout;
            }
        }
    });

    app.post('/api/backup/server/save', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;
        try {
            await flushPendingDb();
            const dbBackupValue = await createCompatibleDatabaseValue({ exportColors: true });

            // Pre-flight disk check — bail before streaming if the target dir
            // can't fit the backup. Avoids wasted minutes + half-written tmp files.
            try {
                const estimate = await estimateServerBackupSize(dbBackupValue?.length);
                const required = Math.ceil(estimate * 1.05); // 5% safety margin
                const sf = await fs.statfs(backupState.backupsDir);
                const free = sf.bsize * sf.bavail;
                if (estimate > 0 && free < required) {
                    return res.status(400).json({
                        error: `Insufficient disk space (need ~${(required / 1024 / 1024).toFixed(0)} MB, free ${(free / 1024 / 1024).toFixed(0)} MB)`,
                        code: 'insufficient_space',
                        required,
                        free,
                    });
                }
            } catch (e) {
                // Non-fatal: log and proceed. statfs may be unavailable, in which
                // case the streaming fallback path below still fails gracefully.
                console.warn('[Backup] pre-flight disk check failed:', e?.message || e);
            }

            const inlayFiles = await listInlayFiles();
            const inlayEntries = await Promise.all(inlayFiles.map(async (entry) => {
                const stat = await fs.stat(entry.filePath);
                return { kind: 'file', sourcePath: entry.filePath, backupName: `inlay/${entry.id}.${entry.ext}`, size: stat.size };
            }));
            const sidecarEntries = (await Promise.all(inlayFiles.map(async (entry) => {
                const sidecarPath = getInlaySidecarPath(entry.id);
                try {
                    const stat = await fs.stat(sidecarPath);
                    return { kind: 'sidecar', sourcePath: sidecarPath, backupName: `inlay_sidecar/${entry.id}`, size: stat.size };
                } catch { return null; }
            }))).filter(Boolean);

            const namespacedEntries = [
                ...kvListWithSizes('assets/').map((e) => ({ kind: 'kv', key: e.key, backupName: path.basename(e.key), size: e.size })),
                ...listColdStorageBackupEntries(),
                ...kvListWithSizes('inlay_meta/').map((e) => ({ kind: 'kv', key: e.key, backupName: e.key, size: e.size })),
                ...inlayEntries,
                ...sidecarEntries,
            ];

            const totalEntries = namespacedEntries.length + 1; // +1 for database
            const totalBytes = namespacedEntries.reduce((sum, e) => sum + e.size, 0) + (dbBackupValue?.length || 0);

            // Stream progress as NDJSON
            res.setHeader('content-type', 'application/x-ndjson');
            res.flushHeaders();

            const filename = `risu-backup-${Date.now()}.bin`;
            const finalPath = path.join(backupState.backupsDir, filename);
            const tmpPath = finalPath + '.tmp';
            const { createWriteStream: createFsWriteStream } = require('fs');
            const writeStream = createFsWriteStream(tmpPath);

            let closed = false;
            let writeComplete = false;
            res.once('close', () => { closed = true; });

            try {
                await new Promise((resolve, reject) => {
                    writeStream.on('error', reject);

                    (async () => {
                        let written = 0;
                        let bytesWritten = 0;
                        for (const entry of namespacedEntries) {
                            if (closed) break;
                            const value = entry.kind === 'kv'
                                ? kvGet(entry.key)
                                : entry.kind === 'buffer'
                                    ? entry.buffer
                                    : await fs.readFile(entry.sourcePath);
                            if (value) {
                                const ok = writeStream.write(encodeBackupEntry(entry.backupName, value));
                                if (!ok) await new Promise(r => writeStream.once('drain', r));
                                bytesWritten += value.length;
                            }
                            written++;
                            if (written % 50 === 0 || written === namespacedEntries.length) {
                                res.write(JSON.stringify({ type: 'progress', current: written, total: totalEntries, bytes: bytesWritten, totalBytes }) + '\n');
                            }
                        }
                        if (closed) throw new Error('Client disconnected during backup save');
                        if (dbBackupValue) {
                            const ok = writeStream.write(encodeBackupEntry('database.risudat', dbBackupValue));
                            if (!ok) await new Promise(r => writeStream.once('drain', r));
                            bytesWritten += dbBackupValue.length;
                        }
                        res.write(JSON.stringify({ type: 'progress', current: totalEntries, total: totalEntries, bytes: bytesWritten, totalBytes }) + '\n');
                        writeStream.end(resolve);
                    })().catch(reject);
                });

                // Atomic rename: only expose the file after successful write
                await fs.rename(tmpPath, finalPath);
                writeComplete = true;

                const stat = await fs.stat(finalPath);
                const note = normalizeBackupNote(req.body?.note);
                if (note) setBackupNote(getBackupNotesDir(), 'server', filename, note);
                console.log(`[Server Backup] Saved: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
                res.write(JSON.stringify({ type: 'done', ok: true, filename, size: stat.size, note }) + '\n');
                res.end();
            } catch (innerError) {
                // Clean up incomplete temp file
                if (!writeComplete) {
                    await fs.unlink(tmpPath).catch(() => {});
                }
                throw innerError;
            }
        } catch (error) {
            if (!res.headersSent) {
                next(error);
            } else {
                res.write(JSON.stringify({
                    type: 'error',
                    message: error.message,
                    ...(error?.code ? { code: error.code } : {}),
                }) + '\n');
                res.end();
            }
        }
    });

    app.get('/api/backup/server/list', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        try {
            const notes = readBackupNotes(getBackupNotesDir());
            let entries;
            try {
                entries = await fs.readdir(backupState.backupsDir, { withFileTypes: true });
            } catch {
                res.json({ backups: [] });
                return;
            }
            const backups = [];
            for (const entry of entries) {
                if (!entry.isFile() || !BACKUP_FILENAME_REGEX.test(entry.name)) continue;
                const stat = await fs.stat(path.join(backupState.backupsDir, entry.name));
                const tsMatch = entry.name.match(/^risu-backup-(\d+)\.bin$/);
                backups.push({
                    filename: entry.name,
                    size: stat.size,
                    createdAt: tsMatch ? Number(tsMatch[1]) : stat.mtimeMs,
                    note: getBackupNote(notes, 'server', entry.name),
                });
            }
            backups.sort((a, b) => b.createdAt - a.createdAt);
            res.json({ backups });
        } catch (error) {
            next(error);
        }
    });

    app.put('/api/backup/notes', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const kind = typeof req.body?.kind === 'string' ? req.body.kind : '';
            const id = typeof req.body?.id === 'string' ? req.body.id : '';
            if (!isValidBackupNoteTarget(kind, id)) {
                return res.status(400).json({ error: 'Invalid backup note target' });
            }
            if (!await backupNoteTargetExists(kind, id)) {
                return res.status(404).json({ error: 'Backup not found' });
            }
            const note = setBackupNote(getBackupNotesDir(), kind, id, req.body?.note);
            res.json({ ok: true, note });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/backup/server/restore', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;

        if (importInProgress) {
            res.status(409).json({ error: 'Another import is already in progress' });
            return;
        }
        importInProgress = true;

        try {
            const filename = req.body?.filename;
            if (!filename || !BACKUP_FILENAME_REGEX.test(filename)) {
                res.status(400).json({ error: 'Invalid backup filename' });
                return;
            }
            const filePath = path.join(backupState.backupsDir, filename);
            let fileStat;
            try {
                fileStat = await fs.stat(filePath);
            } catch {
                res.status(404).json({ error: 'Backup file not found' });
                return;
            }

            const disk = await checkDiskSpace(fileStat.size * BACKUP_DISK_HEADROOM);
            if (!disk.ok) {
                res.status(507).json({
                    error: 'Insufficient disk space',
                    available: disk.available,
                    required: fileStat.size * BACKUP_DISK_HEADROOM,
                });
                return;
            }

            res.setHeader('content-type', 'application/x-ndjson');
            res.flushHeaders();

            let lastProgressWrite = 0;
            const { createReadStream } = require('fs');
            const stream = createReadStream(filePath, { highWaterMark: 256 * 1024 });
            const result = await queueStorageOperation(() => importBackupFromSource(stream, {
                totalBytes: fileStat.size,
                onProgress: (received, total) => {
                    const now = Date.now();
                    if (now - lastProgressWrite < 200) return;
                    lastProgressWrite = now;
                    res.write(JSON.stringify({ type: 'progress', bytes: received, totalBytes: total }) + '\n');
                },
            }));
            broadcastDatabaseInvalidated(req, { allChats: true });
            broadcastBookmarksInvalidated(req);
            res.write(JSON.stringify({
                type: 'done',
                ok: true,
                assetsRestored: result.assetsRestored,
                coldStorageFailed: result.coldStorageFailed,
            }) + '\n');
            res.end();
        } catch (error) {
            if (!res.headersSent) {
                next(error);
            } else {
                res.write(JSON.stringify({
                    type: 'error', message: error.message,
                    ...(error?.code ? { code: error.code } : {}),
                }) + '\n');
                res.end();
            }
        } finally {
            importInProgress = false;
        }
    });

    app.post('/api/backup/server/restore-assets', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;

        if (importInProgress) {
            res.status(409).json({ error: 'Another import is already in progress' });
            return;
        }
        importInProgress = true;

        try {
            const filename = req.body?.filename;
            if (!filename || !BACKUP_FILENAME_REGEX.test(filename)) {
                res.status(400).json({ error: 'Invalid backup filename' });
                return;
            }
            const filePath = path.join(backupState.backupsDir, filename);
            try {
                await fs.access(filePath);
            } catch {
                res.status(404).json({ error: 'Backup file not found' });
                return;
            }

            // Include any debounced DB changes before deciding which assets the
            // current save references. Asset restoration itself is additive.
            await flushPendingDb();
            if (!appDataStore.getState().initialized) {
                res.status(409).json({ error: 'Current database is missing' });
                return;
            }
            const dbObj = appDataStore.exportProjection({ includeMessages: true });
            const referencedBasenames = collectDatabaseAssetBasenames(dbObj, { assetsOnly: true });
            const currentBasenames = new Set(
                kvList('assets/').map((key) => statsBasename(key)),
            );
            const missingBasenames = new Set(
                Array.from(referencedBasenames).filter((name) => !currentBasenames.has(name)),
            );

            res.setHeader('content-type', 'application/x-ndjson');
            res.flushHeaders();

            let lastProgressWrite = 0;
            const result = await restoreMissingAssetsFromBackupFile({
                db: sqliteDb,
                filePath,
                missingBasenames,
                maxEntryNameBytes: BACKUP_ENTRY_NAME_MAX_BYTES,
                onProgress: (bytes, totalBytes) => {
                    const now = Date.now();
                    if (now - lastProgressWrite < 200 && bytes < totalBytes) return;
                    lastProgressWrite = now;
                    res.write(JSON.stringify({ type: 'progress', bytes, totalBytes }) + '\n');
                },
                beforeRestore: async (restoreBytes) => {
                    const required = restoreBytes * BACKUP_DISK_HEADROOM;
                    const disk = await checkDiskSpace(required);
                    if (!disk.ok) {
                        throw new Error(
                            `Insufficient disk space (available=${disk.available}, required=${required})`,
                        );
                    }
                },
            });

            res.write(JSON.stringify({
                type: 'done',
                ok: true,
                referencedAssets: referencedBasenames.size,
                missingAssets: missingBasenames.size,
                ...result,
            }) + '\n');
            res.end();
        } catch (error) {
            if (!res.headersSent) {
                next(error);
            } else {
                res.write(JSON.stringify({ type: 'error', message: error.message }) + '\n');
                res.end();
            }
        } finally {
            importInProgress = false;
        }
    });

    app.delete('/api/backup/server/:filename', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;
        try {
            const filename = req.params.filename;
            if (!BACKUP_FILENAME_REGEX.test(filename)) {
                res.status(400).json({ error: 'Invalid backup filename' });
                return;
            }
            const filePath = path.join(backupState.backupsDir, filename);
            try {
                await fs.unlink(filePath);
            } catch (err) {
                if (err.code === 'ENOENT') {
                    res.status(404).json({ error: 'Backup file not found' });
                    return;
                }
                throw err;
            }
            deleteBackupNote(getBackupNotesDir(), 'server', filename);
            res.json({ ok: true });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/backup/server/download/:filename', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        try {
            const filename = req.params.filename;
            if (!BACKUP_FILENAME_REGEX.test(filename)) {
                res.status(400).json({ error: 'Invalid backup filename' });
                return;
            }
            const filePath = path.join(backupState.backupsDir, filename);
            let stat;
            try {
                stat = await fs.stat(filePath);
            } catch {
                res.status(404).json({ error: 'Backup file not found' });
                return;
            }
            res.setHeader('content-type', 'application/octet-stream');
            res.setHeader('content-disposition', `attachment; filename="${filename}"`);
            res.setHeader('content-length', stat.size);
            const { createReadStream } = require('fs');
            createReadStream(filePath).pipe(res);
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/db/snapshots/limits', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            const { maxCount, maxBytes } = getSnapshotLimits();
            const usage = snapshotUsage();
            res.json({
                maxCount,
                maxBytes,
                currentCount: usage.count,
                currentBytes: usage.bytes,
                logicalBytes: usage.logicalBytes,
                bounds: {
                    minCount: SNAPSHOT_LIMIT_MIN_COUNT,
                    maxCount: SNAPSHOT_LIMIT_MAX_COUNT,
                    minBytes: SNAPSHOT_LIMIT_MIN_BYTES,
                    maxBytes: SNAPSHOT_LIMIT_MAX_BYTES,
                },
                defaults: {
                    count: SNAPSHOT_LIMIT_DEFAULT_COUNT,
                    bytes: SNAPSHOT_LIMIT_DEFAULT_BYTES,
                },
            });
        } catch (err) { next(err); }
    });

    app.put('/api/db/snapshots/limits', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const rawCount = Number(req.body?.maxCount);
            const rawBytes = Number(req.body?.maxBytes);
            if (!Number.isFinite(rawCount) || rawCount < SNAPSHOT_LIMIT_MIN_COUNT || rawCount > SNAPSHOT_LIMIT_MAX_COUNT) {
                return res.status(400).json({ error: `maxCount out of range (${SNAPSHOT_LIMIT_MIN_COUNT}-${SNAPSHOT_LIMIT_MAX_COUNT})` });
            }
            if (!Number.isFinite(rawBytes) || rawBytes < SNAPSHOT_LIMIT_MIN_BYTES || rawBytes > SNAPSHOT_LIMIT_MAX_BYTES) {
                return res.status(400).json({ error: `maxBytes out of range` });
            }
            const maxCount = Math.floor(rawCount);
            const maxBytes = Math.floor(rawBytes);
            kvSet(SNAPSHOT_LIMIT_COUNT_KEY, Buffer.from(String(maxCount), 'utf-8'));
            kvSet(SNAPSHOT_LIMIT_BYTES_KEY, Buffer.from(String(maxBytes), 'utf-8'));
            const trim = trimSnapshotsToLimits();
            const usage = snapshotUsage();
            res.json({
                maxCount, maxBytes,
                currentCount: usage.count,
                currentBytes: usage.bytes,
                logicalBytes: usage.logicalBytes,
                removed: trim.removed,
            });
        } catch (err) { next(err); }
    });

    app.get('/api/db/snapshots', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            const out = kvList(DB_BACKUP_PREFIX).map((key) => {
                const tsRaw = parseInt(key.slice(DB_BACKUP_PREFIX.length, -4), 10);
                const ts = Number.isFinite(tsRaw) ? tsRaw * 100 : null;
                // Logical size — the full data this snapshot represents (the whole DB),
                // not its marginal on-disk cost. Users expect "this backup = my 53 MB
                // DB"; the dedup win is shown once, as the section's savings figure.
                // (kvSize reassembles via the manifest; the marker's 13 bytes are not
                // what a user wants to see for a full backup.) Trimming still sizes by
                // snapshotFootprint in db.cjs, so this display change can't over-trim.
                return { key, size: kvSize(key) || 0, timestamp: ts };
            }).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
            res.json({ snapshots: out });
        } catch (err) { next(err); }
    });

    app.delete('/api/db/snapshots', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const key = typeof req.query?.key === 'string' ? req.query.key : '';
            // Restrict to snapshot prefix — never let this endpoint touch other kv keys.
            if (!key.startsWith(DB_BACKUP_PREFIX)) {
                return res.status(400).json({ error: 'Invalid snapshot key' });
            }
            deleteSnapshotState(key);
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

    app.post('/api/db/snapshots/promote', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const key = typeof req.body?.key === 'string' ? req.body.key : '';
            const note = normalizeBackupNote(req.body?.note);
            if (!key.startsWith(DB_BACKUP_PREFIX)) {
                return res.status(400).json({ error: 'Invalid snapshot key' });
            }
            if (!note) {
                return res.status(400).json({ error: 'A note is required to preserve this snapshot' });
            }
            const raw = kvGet(key);
            if (!raw) return res.status(404).json({ error: 'Snapshot not found' });

            const database = normalizeJSON(await decodeRisuSave(raw));
            // New snapshots keep bookmarks in a dedicated snapshot table. Project
            // that historical catalog into the portable file; legacy snapshots
            // already carry their bookmark compatibility fields in the blob.
            bookmarkStore.projectSnapshotDatabaseCompatibility(key, database);
            const blob = Buffer.from(encodeRisuSaveLegacy(database, 'compression'));

            const dir = getManualSnapshotsDir();
            await fs.mkdir(dir, { recursive: true });
            try {
                const stat = await fs.statfs(dir);
                const required = Math.ceil(blob.length * 1.05);
                if (stat.bsize * stat.bavail < required) {
                    return res.status(400).json({
                        error: `Insufficient disk space (need ~${(required / 1024 / 1024).toFixed(0)} MB)`,
                        code: 'insufficient_space',
                        required,
                        free: stat.bsize * stat.bavail,
                    });
                }
            } catch (error) {
                if (error?.code === 'insufficient_space') throw error;
                logger.warn('[Snapshot promotion] pre-flight disk check failed:', error?.message || error);
            }

            const tick = parseInt(key.slice(DB_BACKUP_PREFIX.length, -4), 10);
            const timestamp = Number.isFinite(tick) ? tick * 100 : Date.now();
            const filename = makeManualSnapshotFilename(timestamp);
            const finalPath = path.join(dir, filename);
            const temporaryPath = finalPath + '.tmp';
            let fileCreated = false;
            try {
                await fs.writeFile(temporaryPath, blob);
                await fs.rename(temporaryPath, finalPath);
                fileCreated = true;
                setBackupNote(getBackupNotesDir(), 'manual', filename, note);
                deleteSnapshotState(key);
            } catch (error) {
                await fs.unlink(temporaryPath).catch(() => {});
                if (fileCreated) await fs.unlink(finalPath).catch(() => {});
                deleteBackupNote(getBackupNotesDir(), 'manual', filename);
                throw error;
            }

            res.json({
                ok: true,
                snapshot: { filename, size: blob.length, timestamp, note },
            });
        } catch (err) { next(err); }
    });

    async function restoreDatabaseBlob(blob, options = {}) {
        await queueStorageOperation(async () => {
            // Drain any pending debounced persist first — same pattern as
            // /api/db/optimize. Without this, an in-flight save could land
            // after the restore and overwrite the restored snapshot.
            await flushPendingDb();
            const decoded = await decodeRisuSave(Buffer.from(blob));
            const { database } = normalizeLegacyDatabaseProjection(decoded);
            sqliteDb.transaction(() => {
                const restoredBookmarkSnapshot = options.bookmarkSnapshotKey
                    ? bookmarkStore.restoreSnapshot(options.bookmarkSnapshotKey)
                    : false;
                if (options.importBookmarkCompatibility
                    || (options.bookmarkSnapshotKey && !restoredBookmarkSnapshot)) {
                    bookmarkStore.replaceDatabaseCompatibility(database);
                } else {
                    bookmarkStore.migrateLegacyDatabase(database);
                }
                // Snapshot blobs contain compatibility fields by design. A restored
                // bookmark side-table does not mutate that decoded object, so strip
                // them unconditionally before installing canonical chat rows.
                bookmarkStore.stripDatabaseCompatibility(database);
                appDataStore.replaceFromProjection(database, {
                    expectedRevision: appDataStore.getState().revision,
                });
            })();
            refreshCanonicalDatabaseCache({ invalidateChats: true });
        });
    }

    app.post('/api/db/snapshots/restore', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const key = typeof req.body?.key === 'string' ? req.body.key : '';
            if (!key.startsWith(DB_BACKUP_PREFIX)) {
                return res.status(400).json({ error: 'Invalid snapshot key' });
            }
            const blob = kvGet(key);
            if (!blob) {
                return res.status(404).json({ error: 'Snapshot not found' });
            }
            await restoreDatabaseBlob(blob, { bookmarkSnapshotKey: key });
            broadcastDatabaseInvalidated(req, { allChats: true });
            broadcastBookmarksInvalidated(req);
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

    app.get('/api/db/manual-snapshots', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            const dir = getManualSnapshotsDir();
            const notes = readBackupNotes(getBackupNotesDir());
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return res.json({ snapshots: [], path: dir });
            }
            const snapshots = [];
            for (const entry of entries) {
                if (!entry.isFile() || !MANUAL_SNAPSHOT_FILENAME_REGEX.test(entry.name)) continue;
                const stat = await fs.stat(path.join(dir, entry.name));
                const tsMatch = entry.name.match(/^dbbackup-(\d+)\.bin$/);
                snapshots.push({
                    filename: entry.name,
                    size: stat.size,
                    timestamp: tsMatch ? Number(tsMatch[1]) * 100 : stat.mtimeMs,
                    note: getBackupNote(notes, 'manual', entry.name),
                });
            }
            snapshots.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
            res.json({ snapshots, path: dir });
        } catch (err) { next(err); }
    });

    app.post('/api/db/manual-snapshots', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            await flushPendingDb();
            const blob = await createCompatibleDatabaseValue();
            if (!blob) {
                return res.status(404).json({ error: 'Database not found' });
            }
            const dir = getManualSnapshotsDir();
            await fs.mkdir(dir, { recursive: true });

            try {
                const sf = await fs.statfs(dir);
                const free = sf.bsize * sf.bavail;
                const required = Math.ceil(blob.length * 1.05);
                if (free < required) {
                    return res.status(400).json({
                        error: `Insufficient disk space (need ~${(required / 1024 / 1024).toFixed(0)} MB, free ${(free / 1024 / 1024).toFixed(0)} MB)`,
                        code: 'insufficient_space',
                        required,
                        free,
                    });
                }
            } catch (e) {
                console.warn('[Manual Snapshot] pre-flight disk check failed:', e?.message || e);
            }

            const filename = makeManualSnapshotFilename();
            const finalPath = path.join(dir, filename);
            const tmpPath = finalPath + '.tmp';
            await fs.writeFile(tmpPath, Buffer.from(blob));
            await fs.rename(tmpPath, finalPath);
            const stat = await fs.stat(finalPath);
            const tsMatch = filename.match(/^dbbackup-(\d+)\.bin$/);
            const note = normalizeBackupNote(req.body?.note);
            if (note) setBackupNote(getBackupNotesDir(), 'manual', filename, note);
            res.json({
                ok: true,
                snapshot: {
                    filename,
                    size: stat.size,
                    timestamp: tsMatch ? Number(tsMatch[1]) * 100 : stat.mtimeMs,
                    note,
                },
                path: dir,
            });
        } catch (err) { next(err); }
    });

    app.delete('/api/db/manual-snapshots', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const filename = typeof req.query?.filename === 'string' ? req.query.filename : '';
            if (!MANUAL_SNAPSHOT_FILENAME_REGEX.test(filename)) {
                return res.status(400).json({ error: 'Invalid snapshot filename' });
            }
            const filePath = path.join(getManualSnapshotsDir(), filename);
            try {
                await fs.unlink(filePath);
            } catch (err) {
                if (err.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Snapshot not found' });
                }
                throw err;
            }
            deleteBackupNote(getBackupNotesDir(), 'manual', filename);
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

    app.post('/api/db/manual-snapshots/restore', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const filename = typeof req.body?.filename === 'string' ? req.body.filename : '';
            if (!MANUAL_SNAPSHOT_FILENAME_REGEX.test(filename)) {
                return res.status(400).json({ error: 'Invalid snapshot filename' });
            }
            const filePath = path.join(getManualSnapshotsDir(), filename);
            let blob;
            try {
                blob = await fs.readFile(filePath);
            } catch (err) {
                if (err.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Snapshot not found' });
                }
                throw err;
            }
            await restoreDatabaseBlob(blob, { importBookmarkCompatibility: true });
            broadcastDatabaseInvalidated(req, { allChats: true });
            broadcastBookmarksInvalidated(req);
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

    const BOOT_REMINDER_KEY = 'config/boot-backup-reminder';

    function readBootReminder() {
        try {
            const raw = kvGet(BOOT_REMINDER_KEY);
            if (!raw) return false;
            return Buffer.from(raw).toString('utf-8').trim() === '1';
        } catch { return false; }
    }

    app.get('/api/backup/boot-reminder', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            res.json({ enabled: readBootReminder() });
        } catch (err) { next(err); }
    });

    app.put('/api/backup/boot-reminder', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const enabled = !!req.body?.enabled;
            kvSet(BOOT_REMINDER_KEY, Buffer.from(enabled ? '1' : '0', 'utf-8'));
            res.json({ enabled });
        } catch (err) { next(err); }
    });

    app.get('/api/backup/schedule', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            res.json(readBackupSchedule());
        } catch (err) { next(err); }
    });

    app.put('/api/backup/schedule', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const schedule = normalizeBackupSchedule(req.body ?? {});
            kvSet(BACKUP_SCHEDULE_KEY, Buffer.from(JSON.stringify(schedule), 'utf-8'));
            res.json(schedule);
        } catch (err) { next(err); }
    });

    app.get('/api/backup/server/path', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            res.json({
                path: backupState.backupsDir,
                default: DEFAULT_BACKUPS_DIR,
                isDefault: backupState.backupsDir === DEFAULT_BACKUPS_DIR,
            });
        } catch (err) { next(err); }
    });

    app.put('/api/backup/server/path', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const next = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
            if (!next) {
                return res.status(400).json({ error: 'Path required' });
            }
            const resolved = path.resolve(next);
            if (isManagedBackupPath(resolved)) {
                return res.status(400).json({
                    error: 'Backup path cannot be inside PocketRisu Kei app files. Choose a separate folder such as data/backups.',
                });
            }
            // Ensure parent exists / target is writable. Create the dir if missing.
            try {
                if (!existsSync(resolved)) {
                    mkdirSync(resolved, { recursive: true });
                }
                // Probe writability with a tmpfile.
                const probe = path.join(resolved, `.risu-write-probe-${Date.now()}`);
                require('fs').writeFileSync(probe, '');
                require('fs').unlinkSync(probe);
            } catch (e) {
                return res.status(400).json({ error: 'Path is not writable: ' + (e?.message || String(e)) });
            }
            const previous = backupState.backupsDir;
            backupState.backupsDir = resolved;
            kvSet(BACKUP_PATH_CONFIG_KEY, Buffer.from(resolved, 'utf-8'));
            writeBackupPathMarker(resolved);
            res.json({
                path: backupState.backupsDir,
                previous,
                default: DEFAULT_BACKUPS_DIR,
                isDefault: backupState.backupsDir === DEFAULT_BACKUPS_DIR,
            });
        } catch (err) { next(err); }
    });
}

module.exports = { installBackupRoutes };

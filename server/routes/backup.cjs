'use strict';

const { db: sqliteDb, kvList, snapshotSetFootprint, kvSize, kvGet, kvSet, kvDel, kvDelPrefix, clearEntities, checkpointWal, kvListWithSizes } = require('../db.cjs');
const path = require('path');
const fs = require('fs/promises');
const { existsSync, mkdirSync, createReadStream } = require('fs');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { encode: encodeMessagePack } = require('msgpackr');
const { decodeRisuSave, encodeRisuSave } = require('../utils/risuSave.cjs');
const { normalizeJSON } = require('../utils/json.cjs');
const { createBackupRestoreService, restoreMissingAssetsFromBackupFile } = require('../dataRestore/index.cjs');
const { logger } = require('../logs/logs.cjs');
const { buildSettingsBackupPlan } = require('../settingsBackup.cjs');
const {
    exportPromptPresetSelection,
    importPromptPresetSelection,
} = require('../../shared/promptPresetSelection.mjs');
const {
    STORED_ASSET_PREFIX,
    collectDatabaseAssetBasenames,
    collectPersistentPluginAssetBasenames,
    assetBasename: statsBasename,
} = require('../assetReferences.cjs');
const { normalizeBackupNote, setBackupNote, readBackupNotes, getBackupNote, deleteBackupNote } = require('../backupNotes.cjs');
const { codes: API_ERROR_CODES, createApiError, sendApiError } = require('../utils/apiErrors.cjs');

function installBackupRoutes(app, {
    checkDownloadAuth,
    deleteSnapshotStateRows,
    DB_BACKUP_PREFIX,
    backupState,
    BACKUP_FILENAME_REGEX,
    normalizeLegacyDatabaseProjection,
    bookmarkStore,
    appDataStore,
    createBackupAndRotate,
    savePath,
    inlayDir,
    inlayMigrationMarker,
    prepareDatabaseExport,
    normalizeInlayExt,
    isSafeInlayId,
    decodeDataUri,
    ensureInlayDir,
    normalizeColdStorageStorageKey,
    normalizeColdStorageBackupBuffer,
    ensureCanonicalStorage,
    checkAuth,
    listInlayFiles,
    getInlaySidecarPath,
    listColdStorageBackupEntries,
    requireSyncClientId,
    queueStorageOperation,
    broadcastDatabaseInvalidated,
    broadcastBookmarksInvalidated,
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
    syncTrashRetention,
    DEFAULT_BACKUPS_DIR,
    BACKUP_PATH_CONFIG_KEY,
    writeBackupPathMarker,
}) {
    const deleteSnapshotState = sqliteDb.transaction(deleteSnapshotStateRows);

    // Physical usage matches quota trimming; logicalBytes measures dedup savings.
    function snapshotUsage() {
        const keys = kvList(DB_BACKUP_PREFIX);
        const bytes = snapshotSetFootprint(keys);
        let logicalBytes = 0;
        for (const k of keys) {
            logicalBytes += (kvSize(k) || 0);
        }
        return { count: keys.length, bytes, logicalBytes };
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

    const PLUGIN_STORAGE_BACKUP_NAMESPACES = Object.freeze(['localStorage', 'localForage']);
    // Older and upstream backups omit this marker so restore preserves local plugin state.
    const PLUGIN_STORAGE_BACKUP_MANIFEST = 'plugin-storage/_manifest';

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

    function encodeBackupEntryHeader(name, size) {
        const encodedName = Buffer.from(name, 'utf-8');
        const header = Buffer.allocUnsafe(8 + encodedName.length);
        header.writeUInt32LE(encodedName.length, 0);
        encodedName.copy(header, 4);
        header.writeUInt32LE(size, 4 + encodedName.length);
        return header;
    }

    function createBackupProgressWriter(res) {
        const lastPercentByStage = new Map();
        return (progress) => {
            if (res.destroyed || res.writableEnded) throw new Error('Client disconnected during backup');
            if (progress.stage === 'compressing' || progress.stage === 'writing') {
                const percent = progress.totalBytes > 0
                    ? Math.floor(progress.bytes / progress.totalBytes * 100)
                    : 100;
                if (lastPercentByStage.get(progress.stage) === percent) return;
                lastPercentByStage.set(progress.stage, percent);
            }
            res.write(JSON.stringify({ type: 'progress', ...progress }) + '\n');
        };
    }

    async function* generateBackupEntries(plan, onProgress) {
        let bytes = 0;
        for (const entry of plan.entries) {
            const header = encodeBackupEntryHeader(entry.backupName, entry.size);
            yield header;
            bytes += header.length;
            const source = entry.kind === 'kv'
                ? [kvGet(entry.key)]
                : entry.kind === 'buffer'
                    ? [entry.buffer]
                    : createReadStream(entry.sourcePath);
            let entryBytes = 0;
            for await (const chunk of source) {
                if (!chunk) throw new Error(`Backup entry not found: ${entry.backupName}`);
                yield chunk;
                entryBytes += chunk.length;
                bytes += chunk.length;
                onProgress?.({ bytes, totalBytes: plan.totalBytes });
            }
            if (entryBytes !== entry.size) throw new Error(`Backup entry changed: ${entry.backupName}`);
        }
    }

    async function prepareImportedDatabaseProjection(raw, context) {
        const skippedSaveBlocks = [];
        const decoded = await decodeRisuSave(Buffer.from(raw), { skippedBlocks: skippedSaveBlocks });
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
            throw new TypeError('Imported database projection must be an object');
        }
        const { database, coldRestoreResult } = normalizeLegacyDatabaseProjection(decoded, context);

        return {
            coldStorageFailed: coldRestoreResult.characters.failed,
            pluginStorageColdFailed: coldRestoreResult.pluginStorage.failed,
            discardedStorageKeys: coldRestoreResult.pluginStorage.discardedStorageKeys,
            skippedSaveBlocks,
            install() {
                bookmarkStore.replaceDatabaseCompatibility(database);
                return appDataStore.replaceFromProjection(database, {
                    expectedRevision: appDataStore.getState().revision,
                });
            },
        };
    }

    function restoreResultBody({ assetsRestored, coldStorageFailed, pluginStorageColdFailed, skippedSaveBlocks }) {
        return { ok: true, assetsRestored, coldStorageFailed, pluginStorageColdFailed, skippedSaveBlocks };
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
        createBackupAndRotate: createPreReplacementSnapshot,
        syncTrashRetention,
        prepareDatabaseProjection: prepareImportedDatabaseProjection,
        replacePluginStorage: (entries) => appDataStore.replacePluginStorage(entries),
        normalizeInlayExt,
        isSafeInlayId,
        decodeDataUri,
        ensureInlayDir,
        normalizeColdStorageStorageKey,
        normalizeColdStorageBackupBuffer,
        logger,
        maxEntryNameBytes: BACKUP_ENTRY_NAME_MAX_BYTES,
    });

    async function createSettingsBackupPlan(includeModuleAssets = true, includePluginStorage = true) {
        const snapshot = await queueStorageOperation(async () => {
            await prepareDatabaseExport();
            if (!appDataStore.getState().initialized) return null;
            return {
                database: appDataStore.exportProjection({ includeMessages: false }),
                assetRows: kvListWithSizes(STORED_ASSET_PREFIX),
                pluginStorage: includePluginStorage
                    ? Array.from(appDataStore.exportPluginStorage())
                    : [],
            };
        });
        if (!snapshot) return null;
        const plan = buildSettingsBackupPlan({
            ...snapshot,
            includeModuleAssets,
        });
        return {
            ...plan,
            pluginStorage: snapshot.pluginStorage,
        };
    }

    async function createPartialBackupPlan(includePluginStorage = true) {
        const snapshot = await getDatabaseExportSnapshot(includePluginStorage);
        const database = snapshot?.database;
        if (!database) return null;

        const imageDatabase = {
            customBackground: database.customBackground,
            userIcon: database.userIcon,
            characters: (database.characters ?? []).map((character) => ({
                image: character?.image,
                trashFolder: character?.trashFolder,
            })),
            personas: (database.personas ?? []).map((persona) => ({ icon: persona?.icon })),
            characterOrder: database.characterOrder,
            botPresets: (database.botPresets ?? []).map((preset) => ({ image: preset?.image })),
        };
        const referencedNames = collectDatabaseAssetBasenames(imageDatabase, { assetsOnly: true });
        for (const name of collectPersistentPluginAssetBasenames(snapshot.pluginStorage)) {
            referencedNames.add(name);
        }
        const pngNames = new Set(Array.from(referencedNames).filter((name) => name.endsWith('.png')));
        const assetRows = kvListWithSizes(STORED_ASSET_PREFIX);
        const includedAssets = assetRows.filter((asset) => pngNames.has(statsBasename(asset.key)));
        const includedNames = new Set(includedAssets.map((asset) => statsBasename(asset.key)));

        return {
            database,
            includedAssets,
            missingAssets: Array.from(pngNames).filter((name) => !includedNames.has(name)),
        };
    }

    async function getDatabaseExportSnapshot(includePluginStorage = false) {
        return queueStorageOperation(async () => {
            await prepareDatabaseExport();
            if (!appDataStore.getState().initialized) return null;
            const database = appDataStore.exportProjection({ includeMessages: true });
            bookmarkStore.projectDatabaseCompatibility(database);
            return {
                database,
                pluginStorage: includePluginStorage ? Array.from(appDataStore.exportPluginStorage()) : [],
            };
        });
    }

    function createPluginStorageBackupEntries(rows) {
        const entries = [{
            kind: 'buffer',
            backupName: PLUGIN_STORAGE_BACKUP_MANIFEST,
            sortKey: PLUGIN_STORAGE_BACKUP_MANIFEST,
            buffer: Buffer.from(JSON.stringify({
                version: 1,
                namespaces: PLUGIN_STORAGE_BACKUP_NAMESPACES,
            })),
        }];

        for (const row of rows) {
            const encodedKey = Buffer.from(row.key, 'utf-8').toString('base64url');
            const backupName = `plugin-storage/${row.namespace}/${encodedKey}`;
            if (Buffer.byteLength(backupName, 'utf-8') > BACKUP_ENTRY_NAME_MAX_BYTES) {
                throw new Error(`Plugin storage backup entry name too long: ${row.namespace}`);
            }
            const buffer = encodeMessagePack({
                value: Buffer.from(row.value),
                ...(typeof row.owner === 'string' ? { owner: row.owner } : {}),
            });
            entries.push({
                kind: 'buffer',
                backupName,
                sortKey: backupName,
                buffer,
            });
        }

        return entries.map((entry) => ({
            ...entry,
            size: entry.buffer.length,
        }));
    }

    async function createCompatibleDatabaseValue() {
        const snapshot = await getDatabaseExportSnapshot();
        if (!snapshot) return null;
        return encodeRisuSave(exportPromptPresetSelection(snapshot.database));
    }

    async function encodePortableDatabase(database, onCompress) {
        const { withExportColorSchemes } = await import('../utils/colorScheme.js');
        return encodeRisuSave(
            withExportColorSchemes(exportPromptPresetSelection(database)),
            onCompress,
        );
    }

    app.get('/api/backup/export/settings-estimate', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        const plan = await createSettingsBackupPlan();
        if (!plan) return sendApiError(res, 500, API_ERROR_CODES.DATABASE_NOT_FOUND);
        const encodedDatabase = await encodePortableDatabase(plan.database);
        const pluginStorageBytes = createPluginStorageBackupEntries(plan.pluginStorage)
            .reduce((sum, entry) => sum + entry.size, 0);
        res.json({ ...plan.breakdown, dbBytes: encodedDatabase.length, pluginStorageBytes });
    });

    const preparedExports = new Map();
    const PREPARED_EXPORT_TTL_MS = 60_000;
    const MAX_PREPARED_EXPORTS = 4;

    async function prepareBackupExport(options, onProgress) {
        // ?target=upstream excludes application-specific inlay namespaces and
        // plugin storage entries. The database still contains includedInSave
        // under pluginCustomStorage for RisuAI compatibility.
        const target = options.target === 'upstream' ? 'upstream' : 'pocketrisu';
        const settingsOnly = options.mode === 'settings';
        const partialOnly = options.mode === 'partial';
        const includeModuleAssets = options.moduleAssets !== '0';
        onProgress?.({ stage: 'saving' });
        const settingsPlan = settingsOnly
            ? await createSettingsBackupPlan(includeModuleAssets, target !== 'upstream')
            : null;
        const partialPlan = partialOnly ? await createPartialBackupPlan(target !== 'upstream') : null;
        if ((settingsOnly && !settingsPlan) || (partialOnly && !partialPlan)) {
            throw createApiError(API_ERROR_CODES.DATABASE_NOT_FOUND, 500);
        }

        const fullSnapshot = !settingsPlan && !partialPlan
            ? await getDatabaseExportSnapshot(target !== 'upstream')
            : null;
        const database = settingsPlan?.database
            ?? partialPlan?.database
            ?? fullSnapshot?.database;
        if (!database) throw createApiError(API_ERROR_CODES.DATABASE_NOT_FOUND, 500);

        onProgress?.({ stage: 'preparing' });
        const skipInlay = settingsOnly || partialOnly || target === 'upstream';
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
        const pluginStorageEntries = target === 'upstream' || partialOnly
            ? []
            : createPluginStorageBackupEntries(
                settingsPlan?.pluginStorage ?? fullSnapshot?.pluginStorage,
            );
        const namespacedEntries = [
            ...(settingsPlan?.includedAssets ?? partialPlan?.includedAssets ?? kvListWithSizes(STORED_ASSET_PREFIX))
                .map((entry) => ({
                    kind: 'kv',
                    key: entry.key,
                    backupName: path.basename(entry.key),
                    sortKey: entry.key,
                    size: entry.size,
                })),
            ...(settingsOnly || partialOnly ? [] : listColdStorageBackupEntries()),
            ...pluginStorageEntries,
            ...inlayMetaEntries,
            ...inlayEntries,
            ...sidecarEntries.filter(Boolean),
        ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
        const databaseEntry = { kind: 'buffer', backupName: 'database.risudat', size: 0 };
        const entries = [...namespacedEntries, databaseEntry];
        const baseBytes = entries.reduce((sum, entry) => {
            return sum + 8 + Buffer.byteLength(entry.backupName, 'utf-8') + entry.size;
        }, 0);
        databaseEntry.buffer = await encodePortableDatabase(database, onProgress && ((bytes, totalBytes, compressedBytes) => {
            onProgress({ stage: 'compressing', bytes, totalBytes, backupBytes: baseBytes + compressedBytes });
        }));
        databaseEntry.size = databaseEntry.buffer.length;
        const totalBytes = baseBytes + databaseEntry.size;

        const filenameBase = settingsOnly ? 'risu-settings' : partialOnly ? 'risu-backup-partial' : 'risu-backup';
        const filenameSuffix = settingsOnly || partialOnly ? '' : target === 'upstream' ? '-upstream' : '';
        const plan = {
            entries, assetCount: namespacedEntries.length, totalBytes,
            missingAssets: partialPlan?.missingAssets ?? [],
            filename: `${filenameBase}-${Date.now()}${filenameSuffix}.bin`,
        };
        onProgress?.({ stage: 'ready', bytes: plan.totalBytes, totalBytes: plan.totalBytes });
        return plan;
    }

    function takePreparedExport(id) {
        const entry = preparedExports.get(id);
        if (!entry?.plan) throw createApiError(API_ERROR_CODES.BACKUP_NOT_FOUND, 404);
        clearTimeout(entry.timer);
        preparedExports.delete(id);
        return entry.plan;
    }

    app.post('/api/backup/export/prepare', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        if (preparedExports.size >= MAX_PREPARED_EXPORTS) {
            return res.status(429).json({ error: 'Too many prepared backup exports' });
        }
        const id = randomUUID();
        const entry = { plan: null, timer: null };
        preparedExports.set(id, entry);
        try {
            res.setHeader('content-type', 'application/x-ndjson');
            res.setHeader('cache-control', 'no-store, no-transform');
            res.setHeader('x-accel-buffering', 'no');
            res.flushHeaders();
            entry.plan = await prepareBackupExport(req.query, createBackupProgressWriter(res));
            if (res.destroyed) {
                preparedExports.delete(id);
                return;
            }
            // Discard the compressed DB if the browser never follows the download link.
            entry.timer = setTimeout(() => preparedExports.delete(id), PREPARED_EXPORT_TTL_MS);
            entry.timer.unref();
            const download = {
                url: `/api/backup/export?prepared=${id}`,
                missingAssets: entry.plan.missingAssets,
            };
            res.end(JSON.stringify({ type: 'done', ...download }) + '\n');
        } catch (error) {
            clearTimeout(entry.timer);
            preparedExports.delete(id);
            if (res.headersSent) {
                if (!res.destroyed) res.end(JSON.stringify({
                    type: 'error', message: error.message, code: error.code, details: error.details,
                }) + '\n');
            } else {
                next(error);
            }
        }
    });

    app.get('/api/backup/export', async (req, res, next) => {
        if (!await checkDownloadAuth(req, res)) return;
        try {
            const plan = req.query.prepared
                ? takePreparedExport(req.query.prepared)
                : await prepareBackupExport(req.query);
            const { assetCount, totalBytes, filename } = plan;
            res.setHeader('content-type', 'application/octet-stream');
            res.setHeader('content-disposition', `attachment; filename="${filename}"`);
            res.setHeader('content-length', totalBytes);
            res.setHeader('x-risu-backup-assets', assetCount);
            res.flushHeaders();
            await pipeline(
                Readable.from(generateBackupEntries(plan), { objectMode: false }),
                res,
            );
        } catch (error) {
            if (!res.destroyed && !res.writableEnded) next(error);
        }
    });

    app.post('/api/backup/import/prepare', async (req, res) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;
        if (importInProgress) {
            return sendApiError(res, 409, API_ERROR_CODES.BACKUP_IMPORT_IN_PROGRESS);
        }

        const size = Number(req.body?.size ?? 0);
        if (BACKUP_IMPORT_MAX_BYTES > 0 && size > BACKUP_IMPORT_MAX_BYTES) {
            return sendApiError(
                res, 413, API_ERROR_CODES.BACKUP_TOO_LARGE,
                { maxBytes: BACKUP_IMPORT_MAX_BYTES },
            );
        }

        if (size > 0) {
            const disk = await checkDiskSpace(size * BACKUP_DISK_HEADROOM);
            if (!disk.ok) {
                return sendApiError(res, 507, API_ERROR_CODES.INSUFFICIENT_STORAGE, {
                    available: disk.available,
                    required: size * BACKUP_DISK_HEADROOM,
                });
            }
        }

        res.json({ ok: true });
    });

    app.post('/api/backup/import', async (req, res, next) => {
        if(!await checkAuth(req, res)){ return; }
        if (!requireSyncClientId(req, res)) return;

        if (importInProgress) {
            return sendApiError(res, 409, API_ERROR_CODES.BACKUP_IMPORT_IN_PROGRESS);
        }
        importInProgress = true;

        // Disable timeouts for large backup uploads
        const httpServer = req.socket.server;
        const prevRequestTimeout = httpServer?.requestTimeout;
        req.socket.setTimeout(0);
        req.socket.setKeepAlive(true);
        if (httpServer) httpServer.requestTimeout = 0;

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
                return sendApiError(
                    res, 413, API_ERROR_CODES.BACKUP_TOO_LARGE,
                    { maxBytes: BACKUP_IMPORT_MAX_BYTES },
                );
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
                res.write(JSON.stringify({ type: 'done', ...restoreResultBody(result) }) + '\n');
                res.end();
            } else {
                const result = await queueStorageOperation(() => importBackupFromSource(req, {
                    maxBytes: BACKUP_IMPORT_MAX_BYTES,
                }));
                broadcastDatabaseInvalidated(req, { allChats: true });
                broadcastBookmarksInvalidated(req);
                res.json(restoreResultBody(result));
            }
        } catch (error) {
            if (wantsNdjson && res.headersSent) {
                try {
                    res.write(JSON.stringify({
                        type: 'error',
                        message: error?.message || 'backup import failed',
                        ...(error?.code ? { code: error.code } : {}),
                        ...(error?.details ? { details: error.details } : {}),
                    }) + '\n');
                    res.end();
                } catch (_) {}
            } else {
                next(error);
            }
        } finally {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            importInProgress = false;
            if (httpServer && prevRequestTimeout !== undefined) {
                httpServer.requestTimeout = prevRequestTimeout;
            }
        }
    });

    app.post('/api/backup/server/save', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;

        res.setHeader('content-type', 'application/x-ndjson');
        res.setHeader('cache-control', 'no-store, no-transform');
        res.setHeader('x-accel-buffering', 'no');
        res.flushHeaders();

        let closed = !!res.destroyed;
        let writeStream;
        let pipelineActive = false;
        let tmpPath;
        let writeComplete = false;
        const onResponseClose = () => {
            closed = true;
            if (pipelineActive && writeStream && !writeStream.destroyed) {
                writeStream.destroy(new Error('Client disconnected during backup save'));
            }
        };
        res.once('close', onResponseClose);

        const writeProgress = createBackupProgressWriter(res);
        try {
            const plan = await prepareBackupExport({}, writeProgress);
            if (closed || res.destroyed) return;

            // The plan includes encoded entry headers; keep the existing safety margin.
            const estimate = plan.totalBytes;
            const required = Math.ceil(estimate * 1.05);
            let free;
            try {
                const stats = await fs.statfs(backupState.backupsDir);
                free = stats.bsize * stats.bavail;
            } catch (error) {
                console.warn('[Backup] pre-flight disk check failed:', error?.message || error);
            }
            if (estimate > 0 && free !== undefined && free < required) {
                throw createApiError(API_ERROR_CODES.INSUFFICIENT_STORAGE, 507, { required, free });
            }
            if (closed || res.destroyed) return;

            const { filename, missingAssets } = plan;
            const finalPath = path.join(backupState.backupsDir, filename);
            tmpPath = finalPath + '.tmp';
            const { createWriteStream: createFsWriteStream } = require('fs');
            writeStream = createFsWriteStream(tmpPath);
            pipelineActive = true;
            try {
                await pipeline(
                    Readable.from(generateBackupEntries(plan, (progress) => {
                        writeProgress({ stage: 'writing', ...progress });
                    }), { objectMode: false }),
                    writeStream,
                );
            } finally {
                pipelineActive = false;
            }

            if (closed || res.destroyed) throw new Error('Client disconnected during backup save');
            await fs.rename(tmpPath, finalPath);
            writeComplete = true;

            const stat = await fs.stat(finalPath);
            const note = normalizeBackupNote(req.body?.note);
            if (note) setBackupNote(getBackupNotesDir(), 'server', filename, note);
            console.log(`[Server Backup] Saved: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
            if (!closed && !res.destroyed) {
                res.write(JSON.stringify({
                    type: 'done', ok: true, filename, size: stat.size, note, missingAssets,
                }) + '\n');
                res.end();
            }
        } catch (error) {
            if (tmpPath && !writeComplete) await fs.unlink(tmpPath).catch(() => {});
            if (!res.headersSent) {
                next(error);
            } else if (!closed && !res.destroyed && !res.writableEnded) {
                try {
                    res.write(JSON.stringify({
                        type: 'error',
                        message: error.message,
                        ...(error?.code ? { code: error.code } : {}),
                        ...(error?.details ? { details: error.details } : {}),
                    }) + '\n');
                    res.end();
                } catch {}
            }
        } finally {
            res.removeListener('close', onResponseClose);
        }
    });

    app.get('/api/backup/server/list', async (req, res) => {
        if (!await checkAuth(req, res)) { return; }
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
    });

    app.put('/api/backup/notes', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const kind = typeof req.body?.kind === 'string' ? req.body.kind : '';
        const id = typeof req.body?.id === 'string' ? req.body.id : '';
        if (!isValidBackupNoteTarget(kind, id)) {
            return res.status(400).json({ error: 'Invalid backup note target' });
        }
        if (!await backupNoteTargetExists(kind, id)) {
            return sendApiError(res, 404, API_ERROR_CODES.BACKUP_NOT_FOUND);
        }
        const note = setBackupNote(getBackupNotesDir(), kind, id, req.body?.note);
        res.json({ ok: true, note });
    });

    app.post('/api/backup/server/restore', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;

        if (importInProgress) {
            return sendApiError(res, 409, API_ERROR_CODES.BACKUP_IMPORT_IN_PROGRESS);
        }
        importInProgress = true;

        try {
            const filename = req.body?.filename;
            if (!filename || !BACKUP_FILENAME_REGEX.test(filename)) {
                sendApiError(res, 400, API_ERROR_CODES.INVALID_BACKUP_FILENAME);
                return;
            }
            const filePath = path.join(backupState.backupsDir, filename);
            let fileStat;
            try {
                fileStat = await fs.stat(filePath);
            } catch {
                return sendApiError(res, 404, API_ERROR_CODES.BACKUP_NOT_FOUND);
            }

            const disk = await checkDiskSpace(fileStat.size * BACKUP_DISK_HEADROOM);
            if (!disk.ok) {
                return sendApiError(res, 507, API_ERROR_CODES.INSUFFICIENT_STORAGE, {
                    available: disk.available,
                    required: fileStat.size * BACKUP_DISK_HEADROOM,
                });
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
            res.write(JSON.stringify({ type: 'done', ...restoreResultBody(result) }) + '\n');
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
            return sendApiError(res, 409, API_ERROR_CODES.BACKUP_IMPORT_IN_PROGRESS);
        }
        importInProgress = true;

        try {
            const filename = req.body?.filename;
            if (!filename || !BACKUP_FILENAME_REGEX.test(filename)) {
                sendApiError(res, 400, API_ERROR_CODES.INVALID_BACKUP_FILENAME);
                return;
            }
            const filePath = path.join(backupState.backupsDir, filename);
            try {
                await fs.access(filePath);
            } catch {
                return sendApiError(res, 404, API_ERROR_CODES.BACKUP_NOT_FOUND);
            }

            if (!appDataStore.getState().initialized) {
                sendApiError(res, 409, API_ERROR_CODES.DATABASE_NOT_FOUND);
                return;
            }
            const dbObj = appDataStore.exportProjection({ includeMessages: true });
            const referencedBasenames = collectDatabaseAssetBasenames(dbObj, { assetsOnly: true });
            for (const basename of collectPersistentPluginAssetBasenames(appDataStore.exportPluginStorage())) {
                referencedBasenames.add(basename);
            }
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
                        throw createApiError(
                            API_ERROR_CODES.INSUFFICIENT_STORAGE,
                            507,
                            { available: disk.available, required },
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
                res.write(JSON.stringify({
                    type: 'error',
                    message: error.message,
                    ...(error?.code ? { code: error.code } : {}),
                    ...(error?.details ? { details: error.details } : {}),
                }) + '\n');
                res.end();
            }
        } finally {
            importInProgress = false;
        }
    });

    app.delete('/api/backup/server/:filename', async (req, res) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;
        const filename = req.params.filename;
        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            sendApiError(res, 400, API_ERROR_CODES.INVALID_BACKUP_FILENAME);
            return;
        }
        const filePath = path.join(backupState.backupsDir, filename);
        try {
            await fs.unlink(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                return sendApiError(res, 404, API_ERROR_CODES.BACKUP_NOT_FOUND);
            }
            throw err;
        }
        deleteBackupNote(getBackupNotesDir(), 'server', filename);
        res.json({ ok: true });
    });

    app.get('/api/backup/server/download/:filename', async (req, res, next) => {
        if (!await checkDownloadAuth(req, res)) { return; }
        const filename = req.params.filename;
        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            sendApiError(res, 400, API_ERROR_CODES.INVALID_BACKUP_FILENAME);
            return;
        }
        const filePath = path.join(backupState.backupsDir, filename);
        let stat;
        try {
            stat = await fs.stat(filePath);
        } catch {
            return sendApiError(res, 404, API_ERROR_CODES.BACKUP_NOT_FOUND);
        }
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="${filename}"`);
        res.setHeader('content-length', stat.size);
        const { createReadStream } = require('fs');
        const stream = createReadStream(filePath);
        res.once('close', () => stream.destroy());
        stream.once('error', error => {
            if (res.headersSent) res.destroy(error);
            else {
                res.removeHeader('Content-Length');
                res.removeHeader('Content-Disposition');
                next(error);
            }
        });
        stream.pipe(res);
    });

    app.get('/api/db/snapshots/limits', async (req, res) => {
        if (!await checkAuth(req, res)) return;
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
    });

    app.put('/api/db/snapshots/limits', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
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
    });

    app.get('/api/db/snapshots', async (req, res) => {
        if (!await checkAuth(req, res)) return;
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
    });

    app.delete('/api/db/snapshots', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const key = typeof req.query?.key === 'string' ? req.query.key : '';
        // Restrict to snapshot prefix — never let this endpoint touch other kv keys.
        if (!key.startsWith(DB_BACKUP_PREFIX)) {
            return sendApiError(res, 400, API_ERROR_CODES.INVALID_SNAPSHOT_KEY);
        }
        deleteSnapshotState(key);
        res.json({ ok: true });
    });

    app.post('/api/db/snapshots/promote', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const key = typeof req.body?.key === 'string' ? req.body.key : '';
        const note = normalizeBackupNote(req.body?.note);
        if (!key.startsWith(DB_BACKUP_PREFIX)) {
            return sendApiError(res, 400, API_ERROR_CODES.INVALID_SNAPSHOT_KEY);
        }
        if (!note) {
            return res.status(400).json({ error: 'A note is required to preserve this snapshot' });
        }
        const raw = kvGet(key);
        if (!raw) return sendApiError(res, 404, API_ERROR_CODES.SNAPSHOT_NOT_FOUND);

        const database = normalizeJSON(await decodeRisuSave(raw));
        importPromptPresetSelection(database);
        // New snapshots keep bookmarks in a dedicated snapshot table. Project
        // that historical catalog into the portable file; legacy snapshots
        // already carry their bookmark compatibility fields in the blob.
        bookmarkStore.projectSnapshotDatabaseCompatibility(key, database);
        const blob = await encodeRisuSave(exportPromptPresetSelection(database));

        const dir = getManualSnapshotsDir();
        await fs.mkdir(dir, { recursive: true });
        try {
            const stat = await fs.statfs(dir);
            const required = Math.ceil(blob.length * 1.05);
            if (stat.bsize * stat.bavail < required) {
                return sendApiError(res, 507, API_ERROR_CODES.INSUFFICIENT_STORAGE, {
                    required,
                    free: stat.bsize * stat.bavail,
                });
            }
        } catch (error) {
            if (error?.code === API_ERROR_CODES.INSUFFICIENT_STORAGE) throw error;
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
    });

    async function restoreDatabaseBlob(blob, options = {}) {
        await queueStorageOperation(async () => {
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
            syncTrashRetention();
        });
    }

    app.post('/api/db/snapshots/restore', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const key = typeof req.body?.key === 'string' ? req.body.key : '';
        if (!key.startsWith(DB_BACKUP_PREFIX)) {
            return sendApiError(res, 400, API_ERROR_CODES.INVALID_SNAPSHOT_KEY);
        }
        const blob = kvGet(key);
        if (!blob) {
            return sendApiError(res, 404, API_ERROR_CODES.SNAPSHOT_NOT_FOUND);
        }
        await restoreDatabaseBlob(blob, { bookmarkSnapshotKey: key });
        broadcastDatabaseInvalidated(req, { allChats: true });
        broadcastBookmarksInvalidated(req);
        res.json({ ok: true });
    });

    app.get('/api/db/manual-snapshots', async (req, res) => {
        if (!await checkAuth(req, res)) return;
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
    });

    app.post('/api/db/manual-snapshots', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const blob = await createCompatibleDatabaseValue();
        if (!blob) {
            return sendApiError(res, 404, API_ERROR_CODES.DATABASE_NOT_FOUND);
        }
        const dir = getManualSnapshotsDir();
        await fs.mkdir(dir, { recursive: true });

        try {
            const sf = await fs.statfs(dir);
            const free = sf.bsize * sf.bavail;
            const required = Math.ceil(blob.length * 1.05);
            if (free < required) {
                return sendApiError(res, 507, API_ERROR_CODES.INSUFFICIENT_STORAGE, {
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
    });

    app.delete('/api/db/manual-snapshots', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const filename = typeof req.query?.filename === 'string' ? req.query.filename : '';
        if (!MANUAL_SNAPSHOT_FILENAME_REGEX.test(filename)) {
            return sendApiError(res, 400, API_ERROR_CODES.INVALID_BACKUP_FILENAME);
        }
        const filePath = path.join(getManualSnapshotsDir(), filename);
        try {
            await fs.unlink(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                return sendApiError(res, 404, API_ERROR_CODES.SNAPSHOT_NOT_FOUND);
            }
            throw err;
        }
        deleteBackupNote(getBackupNotesDir(), 'manual', filename);
        res.json({ ok: true });
    });

    app.post('/api/db/manual-snapshots/restore', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const filename = typeof req.body?.filename === 'string' ? req.body.filename : '';
        if (!MANUAL_SNAPSHOT_FILENAME_REGEX.test(filename)) {
            return sendApiError(res, 400, API_ERROR_CODES.INVALID_BACKUP_FILENAME);
        }
        const filePath = path.join(getManualSnapshotsDir(), filename);
        let blob;
        try {
            blob = await fs.readFile(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                return sendApiError(res, 404, API_ERROR_CODES.SNAPSHOT_NOT_FOUND);
            }
            throw err;
        }
        await restoreDatabaseBlob(blob, { importBookmarkCompatibility: true });
        broadcastDatabaseInvalidated(req, { allChats: true });
        broadcastBookmarksInvalidated(req);
        res.json({ ok: true });
    });

    const BOOT_REMINDER_KEY = 'config/boot-backup-reminder';

    function readBootReminder() {
        try {
            const raw = kvGet(BOOT_REMINDER_KEY);
            if (!raw) return false;
            return Buffer.from(raw).toString('utf-8').trim() === '1';
        } catch { return false; }
    }

    app.get('/api/backup/boot-reminder', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        res.json({ enabled: readBootReminder() });
    });

    app.put('/api/backup/boot-reminder', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const enabled = !!req.body?.enabled;
        kvSet(BOOT_REMINDER_KEY, Buffer.from(enabled ? '1' : '0', 'utf-8'));
        res.json({ enabled });
    });

    app.get('/api/backup/schedule', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        res.json(readBackupSchedule());
    });

    app.put('/api/backup/schedule', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const schedule = normalizeBackupSchedule(req.body ?? {});
        kvSet(BACKUP_SCHEDULE_KEY, Buffer.from(JSON.stringify(schedule), 'utf-8'));
        res.json(schedule);
    });

    app.get('/api/backup/server/path', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        res.json({
            path: backupState.backupsDir,
            default: DEFAULT_BACKUPS_DIR,
            isDefault: backupState.backupsDir === DEFAULT_BACKUPS_DIR,
        });
    });

    app.put('/api/backup/server/path', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const nextPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
        if (!nextPath) {
            return res.status(400).json({ error: 'Path required' });
        }
        const resolved = path.resolve(nextPath);
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
    });
}

module.exports = { installBackupRoutes };

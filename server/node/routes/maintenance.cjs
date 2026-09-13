'use strict';

const { kvList, kvGet, db: sqliteDb, kvSize, chunkStorageStats, reclaimableChunkBytes, isDbBlobChunked, kvListWithSizes, kvDel, checkpointWal, estimateVacuumRequiredBytes, gcChunks, vacuumDatabase } = require('../db.cjs');
const { STORED_ASSET_PREFIX, findOrphanAssets, collectProtectedAssetBasenames, assetBasename: statsBasename, collectDatabaseAssetBasenames, collectPersistentPluginAssetBasenames } = require('../assetReferences.cjs');
const fs = require('fs/promises');
const path = require('path');
const { logger } = require('../logs/logs.cjs');

function installMaintenanceRoutes(app, {
    checkAuth,
    ensureCanonicalStorage,
    backupState,
    DEFAULT_BACKUPS_DIR,
    sumInlayFsBytes,
    estimateServerBackupSize,
    appDataStore,
    storageState,
    DB_BACKUP_PREFIX,
    BACKUP_FILENAME_REGEX,
    DB_HEX_KEY,
    requireSyncClientId,
    queueStorageOperation,
    flushPendingDb,
}) {
    const assetReferenceStorage = { listKeys: kvList, getValue: kvGet };

    const DB_BLOB_KEY = 'database/database.bin';

    const ASSET_PREFIXES = [
        STORED_ASSET_PREFIX,
        'inlay/',
        'inlay_thumb/',
        'inlay_meta/',
        'inlay_info/',
        'coldstorage/',
        'cache/hypa-vector/',
        'cache/llm-translate/',
    ];

    function statSafe(p) {
        try { return require('fs').statSync(p); } catch { return null; }
    }

    async function diskFreeStat(dirPath) {
        try {
            const sf = await fs.statfs(dirPath);
            return { free: sf.bsize * sf.bavail, total: sf.bsize * sf.blocks };
        } catch { return { free: null, total: null }; }
    }

    app.get('/api/db/stats', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            await ensureCanonicalStorage();
            const saveDir = path.join(process.cwd(), 'save');
            const dbFilePath = path.join(saveDir, 'risuai.db');
            const walPath = dbFilePath + '-wal';
            const shmPath = dbFilePath + '-shm';

            const files = {
                db: statSafe(dbFilePath)?.size ?? 0,
                wal: statSafe(walPath)?.size ?? 0,
                shm: statSafe(shmPath)?.size ?? 0,
            };

            const disk = await diskFreeStat(saveDir);
            // Backup destination disk — same as save/ in the default config but
            // can diverge when the user points backupsDir at a different mount.
            // Surfaced separately so backup-side warnings target the right disk.
            // `sameAsSaveDir` is true when both paths land on the same filesystem
            // (compared by Stat.dev). Dashboard uses this to decide whether to
            // count file backups against the save/ disk in the storage chart.
            let backupDisk;
            if (backupState.backupsDir === DEFAULT_BACKUPS_DIR) {
                backupDisk = { ...disk, path: backupState.backupsDir, sameAsSaveDir: true };
            } else {
                const bDisk = await diskFreeStat(backupState.backupsDir);
                let sameAsSaveDir = false;
                try {
                    const saveStat = require('fs').statSync(saveDir);
                    const bStat = require('fs').statSync(backupState.backupsDir);
                    sameAsSaveDir = saveStat.dev === bStat.dev;
                } catch { /* non-fatal */ }
                backupDisk = { ...bDisk, path: backupState.backupsDir, sameAsSaveDir };
            }

            // The backup page only needs capacity and a conservative next-backup
            // estimate. Do not make that tab wait for chunk reachability, orphan
            // asset discovery, or snapshot accounting used exclusively by the
            // storage dashboard.
            if (req.query?.scope === 'backup') {
                const inlayFsBytes = await sumInlayFsBytes();
                const estimatedBackupSize = await estimateServerBackupSize(
                    appDataStore.getState().initialized
                        ? appDataStore.estimateProjectionBytes()
                        : 0,
                    inlayFsBytes,
                );
                return res.json({
                    files,
                    disk,
                    backupDisk,
                    estimatedBackupSize,
                    inlayFsBytes,
                    etag: storageState.dbEtag,
                });
            }

            const pageSize = sqliteDb.pragma('page_size', { simple: true });
            const pageCount = sqliteDb.pragma('page_count', { simple: true });
            const freelistCount = sqliteDb.pragma('freelist_count', { simple: true });
            const journalMode = sqliteDb.pragma('journal_mode', { simple: true });
            const autoVacuum = sqliteDb.pragma('auto_vacuum', { simple: true });
            const reclaimable = freelistCount * pageSize;

            const dbBlobSize = kvSize(DB_BLOB_KEY) || 0;

            // Physical storage of the chunked DB blob (and all snapshots, which share
            // chunks). This is where the blob bytes actually live post-chunking — kv
            // holds only a tiny marker, so the chart must count this table separately.
            const chunkStat = chunkStorageStats();
            // Bytes the next gc() would reclaim (true orphans + chunks pinned only by
            // stale/raw-overwritten manifests) — drives the Optimize button.
            const orphanChunkBytes = reclaimableChunkBytes();
            const liveChunked = isDbBlobChunked();

            // Prefix breakdown — split database/ into the live blob vs rotated backups.
            const prefixes = {};
            prefixes[DB_BLOB_KEY] = { totalSize: dbBlobSize, count: dbBlobSize > 0 ? 1 : 0 };
            const backupKeys = kvList(DB_BACKUP_PREFIX);
            let backupTotal = 0;
            let backupOldest = null, backupNewest = null;
            for (const k of backupKeys) {
                const sz = kvSize(k) || 0;
                backupTotal += sz;
                const tsRaw = parseInt(k.slice(DB_BACKUP_PREFIX.length, -4), 10);
                if (Number.isFinite(tsRaw)) {
                    const ts = tsRaw * 100;
                    if (!backupOldest || ts < backupOldest) backupOldest = ts;
                    if (!backupNewest || ts > backupNewest) backupNewest = ts;
                }
            }
            prefixes[DB_BACKUP_PREFIX] = { totalSize: backupTotal, count: backupKeys.length };
            let storedAssets = [];
            for (const p of ASSET_PREFIXES) {
                const items = kvListWithSizes(p);
                if (p === STORED_ASSET_PREFIX) storedAssets = items;
                let total = 0;
                for (const it of items) total += it.size;
                prefixes[p] = { totalSize: total, count: items.length };
            }

            const kvRows = sqliteDb.prepare('SELECT COUNT(*) AS c FROM kv').get().c;
            const kvTotalBytes = sqliteDb.prepare('SELECT COALESCE(SUM(LENGTH(value)), 0) AS s FROM kv').get().s;

            let fileBackups = { count: 0, totalSize: 0, oldest: null, newest: null };
            try {
                const entries = await fs.readdir(backupState.backupsDir, { withFileTypes: true });
                for (const e of entries) {
                    if (!e.isFile() || !BACKUP_FILENAME_REGEX.test(e.name)) continue;
                    const st = await fs.stat(path.join(backupState.backupsDir, e.name));
                    fileBackups.count++;
                    fileBackups.totalSize += st.size;
                    const ts = st.mtimeMs;
                    if (!fileBackups.oldest || ts < fileBackups.oldest) fileBackups.oldest = ts;
                    if (!fileBackups.newest || ts > fileBackups.newest) fileBackups.newest = ts;
                }
            } catch { /* backups dir may not exist */ }

            // Quick estimates from in-memory cache only — never decode the BLOB just for stats.
            let orphan = { count: 0, totalSize: 0, available: false };
            const stripped = storageState.dbCache[DB_HEX_KEY];
            if (stripped && Array.isArray(stripped.characters)) {
                const victims = findOrphanAssets(
                    storedAssets,
                    collectProtectedAssetBasenames(stripped, assetReferenceStorage),
                );
                orphan.count = victims.length;
                orphan.totalSize = victims.reduce((sum, asset) => sum + asset.size, 0);
                orphan.available = true;
            }

            // Inlay payload now lives on the filesystem (post-migration) rather
            // than in kv `inlay/*` prefixes. Surface explicitly so the dashboard
            // chart can include it in the inlay slice instead of underreporting.
            const inlayFsBytes = await sumInlayFsBytes();
            const estimatedBackupSize = await estimateServerBackupSize(
                appDataStore.getState().initialized
                    ? appDataStore.estimateProjectionBytes()
                    : 0,
                inlayFsBytes,
            );

            res.json({
                files,
                disk,
                backupDisk,
                sqlite: { pageSize, pageCount, freelistCount, reclaimable, journalMode, autoVacuum },
                chunks: { count: chunkStat.count, bytes: chunkStat.bytes, orphanBytes: orphanChunkBytes, liveChunked },
                prefixes,
                kvRows,
                kvTotalBytes,
                estimatedBackupSize,
                inlayFsBytes,
                backups: {
                    kv: { count: backupKeys.length, totalSize: backupTotal, oldest: backupOldest, newest: backupNewest },
                    file: fileBackups,
                },
                orphan,
                etag: storageState.dbEtag,
            });
        } catch (err) { next(err); }
    });

    app.get('/api/db/stats/characters', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            await ensureCanonicalStorage();
            if (!appDataStore.getState().initialized) {
                res.json({ characters: [], orphan: { count: 0, totalSize: 0 }, chatBytesNote: 'estimate' });
                return;
            }
            const dbObj = storageState.dbCache[DB_HEX_KEY] ?? { characters: [] };

            const assetSize = new Map();
            for (const it of kvListWithSizes('assets/')) {
                assetSize.set(statsBasename(it.key), it.size);
            }
            const claimed = new Set();
            const characters = [];
            const list = appDataStore.listCharacterStorage();
            for (const stored of list) {
                const cha = stored.character;
                if (!cha) continue;
                const refs = [];
                const collect = (v) => { if (v) refs.push(statsBasename(v)); };
                collect(cha.image);
                if (Array.isArray(cha.emotionImages)) for (const em of cha.emotionImages) collect(em?.[1]);
                if (Array.isArray(cha.additionalAssets)) for (const em of cha.additionalAssets) collect(em?.[1]);
                if (cha.vits?.files) for (const k of Object.keys(cha.vits.files)) collect(cha.vits.files[k]);
                if (Array.isArray(cha.ccAssets)) for (const a of cha.ccAssets) collect(a?.uri);

                // Same asset shared across characters is attributed to the first one we see — avoids double-counting.
                let imgBytes = 0;
                for (const bn of refs) {
                    if (!bn || claimed.has(bn)) continue;
                    const sz = assetSize.get(bn);
                    if (sz != null) {
                        imgBytes += sz;
                        claimed.add(bn);
                    }
                }
                const chatBytes = stored.chatBytes;
                const cardBytes = stored.cardBytes;

                characters.push({
                    chaId: cha.chaId || '',
                    name: cha.name || '',
                    image: cha.image || '',
                    trashed: !!cha.trashTime,
                    cardBytes,
                    imgBytes,
                    chatBytes,
                    totalBytes: cardBytes + imgBytes + chatBytes,
                });
            }

            const orphanAssets = findOrphanAssets(
                kvListWithSizes(STORED_ASSET_PREFIX),
                collectProtectedAssetBasenames(dbObj, assetReferenceStorage),
            );

            characters.sort((a, b) => b.totalBytes - a.totalBytes);
            res.json({
                characters,
                orphan: {
                    count: orphanAssets.length,
                    totalSize: orphanAssets.reduce((sum, asset) => sum + asset.size, 0),
                },
                chatBytesNote: 'relational msgpack payload bytes',
                etag: storageState.dbEtag,
            });
        } catch (err) { next(err); }
    });

    app.get('/api/db/stats/modules', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            await ensureCanonicalStorage();
            if (!appDataStore.getState().initialized) {
                res.json({ modules: [] });
                return;
            }
            const list = appDataStore.listModuleStorage();

            const assetSize = new Map();
            for (const it of kvListWithSizes('assets/')) {
                assetSize.set(statsBasename(it.key), it.size);
            }

            const modules = [];
            for (const stored of list) {
                const m = stored.module;
                if (!m) continue;
                const bodyBytes = stored.bodyBytes;

                let assetBytes = 0;
                const seen = new Set();
                if (Array.isArray(m.assets)) {
                    for (const a of m.assets) {
                        const bn = statsBasename(a?.[1]);
                        if (!bn || seen.has(bn)) continue;
                        seen.add(bn);
                        const sz = assetSize.get(bn);
                        if (sz != null) assetBytes += sz;
                    }
                }

                modules.push({
                    id: m.id || m.namespace || m.name || '',
                    name: m.name || m.namespace || '',
                    bodyBytes,
                    assetBytes,
                    totalBytes: bodyBytes + assetBytes,
                });
            }

            modules.sort((a, b) => b.totalBytes - a.totalBytes);
            res.json({ modules, etag: storageState.dbEtag });
        } catch (err) { next(err); }
    });

    app.post('/api/db/assets/purge-orphans', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const result = await queueStorageOperation(async () => {
                // Decide from persisted bytes after pending client writes land; the
                // dashboard's in-memory estimate is informational only.
                await flushPendingDb();
                if (!appDataStore.getState().initialized) {
                    return { error: 'No relational database' };
                }
                const dbObj = appDataStore.exportProjection({ includeMessages: true });
                if (!dbObj || !Array.isArray(dbObj.characters)) {
                    return { error: 'Database decode failed' };
                }

                const storedAssets = kvListWithSizes(STORED_ASSET_PREFIX);
                const explicitAssetReferences = collectDatabaseAssetBasenames(dbObj, { assetsOnly: true });
                if (explicitAssetReferences.size === 0 && storedAssets.length > 0) {
                    return { error: 'Reference scan produced no references — refusing to purge' };
                }
                const databaseReferences = collectDatabaseAssetBasenames(dbObj);
                for (const basename of collectPersistentPluginAssetBasenames(assetReferenceStorage)) {
                    databaseReferences.add(basename);
                }

                const victims = findOrphanAssets(storedAssets, databaseReferences);
                sqliteDb.transaction(() => {
                    for (const asset of victims) kvDel(asset.key);
                })();

                const bytes = victims.reduce((sum, asset) => sum + asset.size, 0);
                if (victims.length > 0) {
                    try { checkpointWal('TRUNCATE'); }
                    catch (error) { logger.warn('[PurgeOrphans] checkpoint failed:', error?.message || error); }
                }
                return { ok: true, deleted: victims.length, bytes, scanned: storedAssets.length };
            });

            if (result.error) return res.status(400).json(result);
            logger.info(`[PurgeOrphans] removed ${result.deleted}/${result.scanned} assets (${result.bytes} bytes)`);
            res.json(result);
        } catch (err) { next(err); }
    });

    app.post('/api/db/optimize', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const saveDir = path.join(process.cwd(), 'save');
            const dbFilePath = path.join(saveDir, 'risuai.db');
            const preDbSize = statSafe(dbFilePath)?.size ?? 0;
            const requiredFreeBytes = estimateVacuumRequiredBytes(preDbSize);

            const { free } = await diskFreeStat(saveDir);
            if (requiredFreeBytes > 0 && free != null && free < requiredFreeBytes) {
                return res.status(400).json({
                    error: 'Insufficient disk space for VACUUM',
                    required: requiredFreeBytes,
                    free,
                });
            }

            const result = await queueStorageOperation(async () => {
                await flushPendingDb();
                const t0 = Date.now();
                // Reclaim chunks orphaned by edits/snapshot rotation before VACUUM, so
                // their pages get compacted in the same pass. Serialized with saves by
                // the surrounding queueStorageOperation.
                let gcDeleted = 0;
                try { gcDeleted = gcChunks(); } catch (e) { logger.warn('[Optimize] chunk gc failed:', e?.message || e); }
                try { checkpointWal('TRUNCATE'); } catch (e) { logger.warn('[Optimize] checkpoint failed:', e?.message || e); }
                vacuumDatabase();
                // VACUUM streams the whole DB through the WAL; without this checkpoint the
                // -wal file stays inflated until the next 5-min background TRUNCATE.
                try { checkpointWal('TRUNCATE'); } catch (e) { logger.warn('[Optimize] post-VACUUM checkpoint failed:', e?.message || e); }
                const elapsed = Date.now() - t0;
                const postDbSize = statSafe(dbFilePath)?.size ?? 0;
                return {
                    ok: true,
                    elapsedMs: elapsed,
                    preDbSize,
                    postDbSize,
                    reclaimed: Math.max(0, preDbSize - postDbSize),
                    chunksReclaimed: gcDeleted,
                };
            });
            res.json(result);
        } catch (err) { next(err); }
    });

    app.post('/api/db/wal-checkpoint', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const saveDir = path.join(process.cwd(), 'save');
            const walFilePath = path.join(saveDir, 'risuai.db-wal');
            const preWalSize = statSafe(walFilePath)?.size ?? 0;

            const result = await queueStorageOperation(async () => {
                await flushPendingDb();
                const t0 = Date.now();
                checkpointWal('TRUNCATE');
                const elapsed = Date.now() - t0;
                const postWalSize = statSafe(walFilePath)?.size ?? 0;
                return {
                    ok: true,
                    elapsedMs: elapsed,
                    preWalSize,
                    postWalSize,
                    reclaimed: Math.max(0, preWalSize - postWalSize),
                };
            });
            res.json(result);
        } catch (err) { next(err); }
    });
}

module.exports = { installMaintenanceRoutes };

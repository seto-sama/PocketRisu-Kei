'use strict';

// Full backup and selective asset restore engines.

const nodeCrypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const Database = require('better-sqlite3');
const { decryptAccountBackup } = require('./accountBackup.cjs');

const DEFAULT_MAX_ENTRY_NAME_BYTES = 1024;
const HASHED_ASSET_NAME = /^([0-9a-f]{64})\.[^/]+$/;

function createBackupRestoreService({
    savePath,
    inlayDir,
    inlayMigrationMarker,
    sqliteDb,
    kvSet,
    kvDel,
    kvDelPrefix,
    clearEntities,
    checkpointWal,
    flushPendingDb,
    createBackupAndRotate,
    invalidateDbCache,
    prepareDatabaseProjection,
    normalizeInlayExt,
    isSafeInlayId,
    decodeDataUri,
    ensureInlayDir,
    normalizeColdStorageStorageKey,
    parseColdStorageJsonBuffer,
    encodeColdStorageCanonicalBuffer,
    logger,
    maxEntryNameBytes = DEFAULT_MAX_ENTRY_NAME_BYTES,
}) {
    function isInvalidBackupPathSegment(name) {
        return (
            !name ||
            name.includes('\0') ||
            name.includes('\\') ||
            name.startsWith('/') ||
            name.includes('../') ||
            name.includes('/..') ||
            name === '.' ||
            name === '..'
        );
    }

    function parseInlayBackupName(name) {
        if (!name.startsWith('inlay/')) return null;
        const suffix = name.slice('inlay/'.length);
        if (!suffix || suffix.includes('/')) return null;
        const dotIdx = suffix.lastIndexOf('.');
        if (dotIdx <= 0) return { id: suffix, ext: null };
        return {
            id: suffix.slice(0, dotIdx),
            ext: suffix.slice(dotIdx + 1),
        };
    }

    function parseInlaySidecarBackupName(name) {
        if (!name.startsWith('inlay_sidecar/')) return null;
        const id = name.slice('inlay_sidecar/'.length);
        if (!isSafeInlayId(id)) return null;
        return { id };
    }

    function resolveBackupStorageKey(name) {
        if (Buffer.byteLength(name, 'utf-8') > maxEntryNameBytes) {
            throw new Error(`Backup entry name too long: ${name.slice(0, 64)}`);
        }
        if (name.startsWith('inlay_thumb/') || name.startsWith('inlay_meta/')) {
            if (isInvalidBackupPathSegment(name)) {
                throw new Error(`Invalid backup entry name: ${name}`);
            }
            return name;
        }
        if (name.startsWith('inlay/')) {
            const parsed = parseInlayBackupName(name);
            if (!parsed || !isSafeInlayId(parsed.id)) {
                throw new Error(`Invalid inlay backup entry name: ${name}`);
            }
            return name;
        }
        if (name.startsWith('inlay_sidecar/')) {
            if (!parseInlaySidecarBackupName(name)) {
                throw new Error(`Invalid inlay sidecar backup entry name: ${name}`);
            }
            return name;
        }
        if (name.startsWith('coldstorage/') || name.startsWith('coldstorage_')) {
            return normalizeColdStorageStorageKey(name);
        }
        if (isInvalidBackupPathSegment(name) || name !== path.basename(name)) {
            throw new Error(`Invalid asset backup entry name: ${name}`);
        }
        return `assets/${name}`;
    }

    function parseBackupChunk(buffer, onEntry) {
        let offset = 0;
        while (offset + 4 <= buffer.length) {
            const nameLength = buffer.readUInt32LE(offset);
            if (nameLength === 0 || nameLength > maxEntryNameBytes) {
                throw new Error(`Invalid backup entry name length: ${nameLength}`);
            }
            if (offset + 4 + nameLength > buffer.length) break;
            const nameStart = offset + 4;
            const nameEnd = nameStart + nameLength;
            const name = buffer.subarray(nameStart, nameEnd).toString('utf-8');
            if (nameEnd + 4 > buffer.length) break;
            const dataLength = buffer.readUInt32LE(nameEnd);
            const dataStart = nameEnd + 4;
            const dataEnd = dataStart + dataLength;
            if (dataEnd > buffer.length) break;
            onEntry(name, buffer.subarray(dataStart, dataEnd));
            offset = dataEnd;
        }
        return buffer.subarray(offset);
    }

    // Shared by uploaded backups and server-local backup restores.
    async function importBackupFromSource(
        dataSource,
        { maxBytes = 0, totalBytes = 0, onProgress = null } = {},
    ) {
        let pendingChunks = [];
        let pendingTotal = 0;
        let nextEntryThreshold = 8;
        let databaseRaw = null;
        let encryptionMarker = null;
        let assetsRestored = 0;
        let bytesReceived = 0;
        const seenEntryNames = new Set();
        const seenStorageKeys = new Set();
        const importedInlayIds = new Set();
        const importedSidecarIds = new Set();
        const explicitSidecarMap = new Map();
        const legacyInlayInfoMap = new Map();

        const stagingDir = path.join(savePath, 'inlays_import_staging');
        const backupInlayDir = path.join(savePath, 'inlays_import_backup');
        const stagingDatabasePath = path.join(savePath, 'backup_restore_stage.sqlite');
        await fs.rm(stagingDir, { recursive: true, force: true });
        await fs.rm(backupInlayDir, { recursive: true, force: true });
        await fs.rm(stagingDatabasePath, { force: true });
        await fs.rm(`${stagingDatabasePath}-journal`, { force: true });
        await fs.rm(`${stagingDatabasePath}-wal`, { force: true });
        await fs.rm(`${stagingDatabasePath}-shm`, { force: true });
        await fs.mkdir(stagingDir, { recursive: true });
        let stagingDb = null;
        let stageKv;
        let getStagedKv;
        let iterateStagedKv;
        let liveInlaysMoved = false;
        let stagedInlaysPromoted = false;
        let restoreCommitted = false;

        async function restorePreviousInlays() {
            if (stagedInlaysPromoted) {
                await fs.rm(inlayDir, { recursive: true, force: true }).catch(() => {});
            }
            let previousInlaysRestored = !liveInlaysMoved;
            if (liveInlaysMoved && fsSync.existsSync(backupInlayDir)) {
                try {
                    await fs.rename(backupInlayDir, inlayDir);
                    previousInlaysRestored = true;
                } catch (restoreError) {
                    // Keep the backup directory recoverable when an OS/filesystem
                    // error prevents the automatic rollback.
                    logger.error(
                        '[Backup Import] Failed to restore previous inlay directory:',
                        restoreError,
                    );
                }
            }
            await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
            if (previousInlaysRestored) {
                await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});
            }
        }

        const stagingInlayFilePath = (id, ext) =>
            path.join(stagingDir, `${id}.${normalizeInlayExt(ext)}`);
        const stagingSidecarPath = (id) => path.join(stagingDir, `${id}.meta.json`);
        function writeStagingInlayFileSync(id, ext, buffer, info) {
            const normalizedExt = normalizeInlayExt(ext);
            fsSync.writeFileSync(stagingInlayFilePath(id, normalizedExt), Buffer.from(buffer));
            fsSync.writeFileSync(stagingSidecarPath(id), JSON.stringify({
                ext: normalizedExt,
                name: typeof info?.name === 'string' ? info.name : id,
                type: typeof info?.type === 'string' ? info.type : 'image',
                height: typeof info?.height === 'number' ? info.height : undefined,
                width: typeof info?.width === 'number' ? info.width : undefined,
            }));
        }
        function writeStagingSidecarSync(id, info) {
            fsSync.writeFileSync(stagingSidecarPath(id), JSON.stringify({
                ext: normalizeInlayExt(info?.ext),
                name: typeof info?.name === 'string' ? info.name : id,
                type: typeof info?.type === 'string' ? info.type : 'image',
                height: typeof info?.height === 'number' ? info.height : undefined,
                width: typeof info?.width === 'number' ? info.width : undefined,
            }));
        }

        try {
            stagingDb = new Database(stagingDatabasePath);
            // The staging file is disposable and never canonical. Disabling its
            // journal avoids doubling a potentially multi-gigabyte backup while the
            // live database keeps its normal durability settings.
            stagingDb.pragma('journal_mode = OFF');
            stagingDb.pragma('synchronous = OFF');
            stagingDb.exec(`
                CREATE TABLE entries (
                    key TEXT PRIMARY KEY,
                    value BLOB NOT NULL
                )
            `);
            stageKv = stagingDb.prepare(
                'INSERT INTO entries(key, value) VALUES (?, ?)',
            );
            getStagedKv = stagingDb.prepare(
                'SELECT value FROM entries WHERE key = ?',
            );
            iterateStagedKv = stagingDb.prepare(
                'SELECT key, value FROM entries ORDER BY rowid',
            );
            await flushPendingDb();
            for await (const chunk of dataSource) {
                bytesReceived += chunk.length;
                if (maxBytes > 0 && bytesReceived > maxBytes) {
                    throw new Error(`Backup exceeds max allowed size (${maxBytes} bytes)`);
                }
                onProgress?.(bytesReceived, totalBytes);
                pendingChunks.push(Buffer.from(chunk));
                pendingTotal += chunk.length;
                if (pendingTotal < nextEntryThreshold) continue;

                const buffer = pendingChunks.length === 1
                    ? pendingChunks[0]
                    : Buffer.concat(pendingChunks, pendingTotal);
                pendingChunks = [];
                pendingTotal = 0;

                const remaining = parseBackupChunk(buffer, (name, data) => {
                    if (seenEntryNames.has(name)) {
                        throw new Error(`Duplicate backup entry: ${name}`);
                    }
                    seenEntryNames.add(name);
                    const inlayRaw = parseInlayBackupName(name);
                    const inlaySidecar = parseInlaySidecarBackupName(name);

                    if (inlayRaw) {
                        importedInlayIds.add(inlayRaw.id);
                        if (inlayRaw.ext) {
                            writeStagingInlayFileSync(
                                inlayRaw.id,
                                inlayRaw.ext,
                                data,
                                legacyInlayInfoMap.get(inlayRaw.id) ||
                                    { ext: inlayRaw.ext, name: inlayRaw.id, type: 'image' },
                            );
                        } else if (data.length > 0 && data[0] === 0x7b) {
                            const parsed = JSON.parse(data.toString('utf-8'));
                            const type = typeof parsed?.type === 'string'
                                ? parsed.type
                                : 'image';
                            const ext = normalizeInlayExt(parsed?.ext);
                            const buffer = type === 'signature'
                                ? Buffer.from(
                                    typeof parsed?.data === 'string' ? parsed.data : '',
                                    'utf-8',
                                )
                                : decodeDataUri(parsed?.data).buffer;
                            writeStagingInlayFileSync(
                                inlayRaw.id,
                                ext,
                                buffer,
                                legacyInlayInfoMap.get(inlayRaw.id) || {
                                    ext,
                                    name: typeof parsed?.name === 'string'
                                        ? parsed.name
                                        : inlayRaw.id,
                                    type,
                                    height: typeof parsed?.height === 'number'
                                        ? parsed.height
                                        : undefined,
                                    width: typeof parsed?.width === 'number'
                                        ? parsed.width
                                        : undefined,
                                },
                            );
                        } else {
                            writeStagingInlayFileSync(
                                inlayRaw.id,
                                'bin',
                                data,
                                legacyInlayInfoMap.get(inlayRaw.id) ||
                                    { ext: 'bin', name: inlayRaw.id, type: 'image' },
                            );
                        }
                        if (explicitSidecarMap.has(inlayRaw.id)) {
                            writeStagingSidecarSync(
                                inlayRaw.id,
                                explicitSidecarMap.get(inlayRaw.id),
                            );
                        } else if (!importedSidecarIds.has(inlayRaw.id)) {
                            const legacyInfo = legacyInlayInfoMap.get(inlayRaw.id);
                            if (legacyInfo) writeStagingSidecarSync(inlayRaw.id, legacyInfo);
                        }
                        assetsRestored += 1;
                    } else if (inlaySidecar) {
                        const parsed = JSON.parse(data.toString('utf-8'));
                        explicitSidecarMap.set(inlaySidecar.id, parsed);
                        writeStagingSidecarSync(inlaySidecar.id, parsed);
                        importedSidecarIds.add(inlaySidecar.id);
                    } else if (name.startsWith('inlay_info/')) {
                        const id = name.slice('inlay_info/'.length);
                        if (!isSafeInlayId(id)) {
                            throw new Error(`Invalid legacy inlay info entry name: ${name}`);
                        }
                        const parsed = JSON.parse(data.toString('utf-8'));
                        legacyInlayInfoMap.set(id, {
                            ext: normalizeInlayExt(parsed?.ext),
                            name: typeof parsed?.name === 'string' ? parsed.name : id,
                            type: typeof parsed?.type === 'string' ? parsed.type : 'image',
                            height: typeof parsed?.height === 'number'
                                ? parsed.height
                                : undefined,
                            width: typeof parsed?.width === 'number'
                                ? parsed.width
                                : undefined,
                        });
                        if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                            writeStagingSidecarSync(id, legacyInlayInfoMap.get(id));
                        }
                    } else if (name === 'encryption.risudat') {
                        encryptionMarker = Buffer.from(data);
                    } else if (name === 'database.risudat') {
                        databaseRaw = Buffer.from(data);
                    } else if (!name.startsWith('inlay_thumb/')) {
                        const storageKey = resolveBackupStorageKey(name);
                        const storageValue = storageKey.startsWith('coldstorage/')
                            ? encodeColdStorageCanonicalBuffer(
                                parseColdStorageJsonBuffer(
                                    data,
                                    name,
                                    { allowPlainJson: true },
                                ).coldData,
                            )
                            : data;
                        if (seenStorageKeys.has(storageKey)) {
                            throw new Error(`Duplicate backup storage key: ${storageKey}`);
                        }
                        seenStorageKeys.add(storageKey);
                        stageKv.run(storageKey, Buffer.from(storageValue));
                        assetsRestored += 1;
                    }
                });

                if (remaining.length === 0) {
                    nextEntryThreshold = 8;
                } else {
                    pendingChunks.push(remaining);
                    pendingTotal = remaining.length;
                    if (remaining.length < 4) {
                        nextEntryThreshold = 8;
                    } else {
                        const nameLen = remaining.readUInt32LE(0);
                        const headerEnd = 4 + nameLen + 4;
                        if (remaining.length < headerEnd) {
                            nextEntryThreshold = headerEnd;
                        } else {
                            const dataLen = remaining.readUInt32LE(4 + nameLen);
                            nextEntryThreshold = headerEnd + dataLen;
                        }
                    }
                }
            }

            if (pendingTotal > 0) {
                throw new Error('Backup stream ended with incomplete entry');
            }
            if (databaseRaw === null) {
                throw new Error('Backup does not contain database.risudat');
            }
            for (const [id, info] of legacyInlayInfoMap.entries()) {
                if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                    writeStagingSidecarSync(id, info);
                }
            }
            if (typeof prepareDatabaseProjection !== 'function') {
                throw new TypeError('prepareDatabaseProjection must be a function');
            }
            // Finish reading/staging first so entry order does not matter and
            // an error can reach the uploading client over the existing stream.
            if (encryptionMarker !== null) {
                databaseRaw = await decryptAccountBackup(databaseRaw, encryptionMarker);
            }
            // Two-phase hook contract: preparation may decode/normalize
            // asynchronously but must not mutate live state. It returns a
            // synchronous install() that replaces relational app/bookmark rows
            // inside the outer transaction below. Imported cold-storage/REMOTE
            // data is available only through this staged, read-only accessor.
            const preparedDatabase = await prepareDatabaseProjection(databaseRaw, {
                getStagedValue(key) {
                    const row = getStagedKv.get(key);
                    return row ? Buffer.from(row.value) : null;
                },
            });
            if (!preparedDatabase || typeof preparedDatabase.install !== 'function') {
                throw new TypeError(
                    'prepareDatabaseProjection must resolve to an object with install()',
                );
            }
            if (preparedDatabase.install.constructor?.name === 'AsyncFunction') {
                throw new TypeError('prepared database install() must be synchronous');
            }

            // Snapshot only after the complete backup and its database projection
            // have been validated. A malformed upload must not rotate backups or
            // touch any live storage.
            createBackupAndRotate();

            // Promote the fully-staged inlay tree immediately before the SQLite
            // commit. If the database transaction fails, restore the prior tree.
            await ensureInlayDir();
            if (fsSync.existsSync(inlayDir)) {
                await fs.rename(inlayDir, backupInlayDir);
                liveInlaysMoved = true;
            }
            await fs.rename(stagingDir, inlayDir);
            stagedInlaysPromoted = true;
            await fs.writeFile(inlayMigrationMarker, new Date().toISOString(), 'utf-8');

            let installResult;
            const replaceLiveState = sqliteDb.transaction(() => {
                kvDelPrefix('assets/');
                kvDelPrefix('inlay/');
                kvDelPrefix('inlay_thumb/');
                kvDelPrefix('inlay_meta/');
                kvDelPrefix('inlay_info/');
                kvDelPrefix('coldstorage/');
                kvDelPrefix('drafts/');
                kvDelPrefix('remotes/');
                // The compatibility projection is import input only. Remove a
                // pre-migration live blob/manifest instead of retaining it in KV.
                kvDel('database/database.bin');
                clearEntities();
                for (const row of iterateStagedKv.iterate()) {
                    kvSet(row.key, row.value);
                }
                installResult = preparedDatabase.install();
                if (installResult && typeof installResult.then === 'function') {
                    throw new TypeError('prepared database install() must be synchronous');
                }
            });
            replaceLiveState();
            restoreCommitted = true;
            await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});

            invalidateDbCache();

            const coldStorageFailed = Number(
                installResult?.coldStorageFailed
                    ?? preparedDatabase.coldStorageFailed
                    ?? 0,
            ) || 0;

            try {
                checkpointWal('TRUNCATE');
            } catch (checkpointError) {
                logger.warn('[Backup Import] WAL checkpoint after import failed:', checkpointError);
            }
            logger.info(
                `[Backup Import] Complete: ${assetsRestored} assets restored, ` +
                `${(bytesReceived / 1024 / 1024).toFixed(1)}MB processed`,
            );
            if (coldStorageFailed > 0) {
                logger.error(
                    `[Backup Import] ${coldStorageFailed} cold storage character(s) could not be restored`,
                );
            }
            return { assetsRestored, bytesReceived, coldStorageFailed };
        } catch (error) {
            if (!restoreCommitted) await restorePreviousInlays();
            throw error;
        } finally {
            try { stagingDb?.close(); } catch (_) {}
            await fs.rm(stagingDatabasePath, { force: true }).catch(() => {});
            await fs.rm(`${stagingDatabasePath}-journal`, { force: true }).catch(() => {});
            await fs.rm(`${stagingDatabasePath}-wal`, { force: true }).catch(() => {});
            await fs.rm(`${stagingDatabasePath}-shm`, { force: true }).catch(() => {});
        }
    }

    return {
        importBackupFromSource,
    };
}

async function readExactly(handle, buffer, position) {
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
            buffer,
            offset,
            buffer.length - offset,
            position + offset,
        );
        if (bytesRead === 0) throw new Error('Backup stream ended with an incomplete entry');
        offset += bytesRead;
    }
}

function readExactlySync(fd, buffer, position) {
    let offset = 0;
    while (offset < buffer.length) {
        const bytesRead = fsSync.readSync(
            fd,
            buffer,
            offset,
            buffer.length - offset,
            position + offset,
        );
        if (bytesRead === 0) throw new Error('Backup stream ended with an incomplete entry');
        offset += bytesRead;
    }
}

function validateHashedAsset(name, value) {
    const match = name.match(HASHED_ASSET_NAME);
    if (!match) return;
    const actual = nodeCrypto.createHash('sha256').update(value).digest('hex');
    if (actual !== match[1]) {
        throw new Error(`Backup asset hash mismatch: ${name}`);
    }
}

/**
 * Restore only currently-missing assets from a local PocketRisu server backup.
 *
 * The backup is scanned completely before any write. Target entries are then
 * hash-checked (for content-addressed names) and inserted in one SQLite
 * transaction with INSERT OR IGNORE, so existing/current assets are never
 * overwritten and malformed backups cannot cause a partial restore.
 */
async function restoreMissingAssetsFromBackupFile({
    db,
    filePath,
    missingBasenames,
    maxEntryNameBytes = DEFAULT_MAX_ENTRY_NAME_BYTES,
    onProgress = null,
    beforeRestore = null,
}) {
    const targets = new Set(
        Array.from(missingBasenames || [])
            .map((name) => String(name))
            .filter((name) => name.length > 0 && path.basename(name) === name),
    );
    if (targets.size === 0) {
        return {
            referencedMissing: 0,
            assetsFound: 0,
            assetsUnavailable: 0,
            assetsRestored: 0,
            restoredBytes: 0,
            skippedExisting: 0,
        };
    }
    const handle = await fs.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        const descriptors = new Map();
        let position = 0;

        // Pass 1: validate the entire framing and remember only target offsets.
        while (position < stat.size) {
            if (position + 4 > stat.size) {
                throw new Error('Backup stream ended with an incomplete entry');
            }
            const nameLengthBuffer = Buffer.allocUnsafe(4);
            await readExactly(handle, nameLengthBuffer, position);
            const nameLength = nameLengthBuffer.readUInt32LE(0);
            if (nameLength === 0 || nameLength > maxEntryNameBytes) {
                throw new Error(`Invalid backup entry name length: ${nameLength}`);
            }

            const nameStart = position + 4;
            const dataLengthPosition = nameStart + nameLength;
            if (dataLengthPosition + 4 > stat.size) {
                throw new Error('Backup stream ended with an incomplete entry');
            }

            const nameBuffer = Buffer.allocUnsafe(nameLength);
            await readExactly(handle, nameBuffer, nameStart);
            const name = nameBuffer.toString('utf-8');
            const dataLengthBuffer = Buffer.allocUnsafe(4);
            await readExactly(handle, dataLengthBuffer, dataLengthPosition);
            const dataLength = dataLengthBuffer.readUInt32LE(0);
            const dataPosition = dataLengthPosition + 4;
            const nextPosition = dataPosition + dataLength;
            if (nextPosition > stat.size) {
                throw new Error(`Truncated backup entry: ${name}`);
            }

            if (targets.has(name)) {
                if (descriptors.has(name)) {
                    throw new Error(`Duplicate backup asset entry: ${name}`);
                }
                descriptors.set(name, { name, dataPosition, dataLength });
            }
            position = nextPosition;
            onProgress?.(position, stat.size);
        }

        const restoreBytes = Array.from(descriptors.values())
            .reduce((sum, entry) => sum + entry.dataLength, 0);
        await beforeRestore?.(restoreBytes);

        const insert = db.prepare(
            'INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        );
        const restore = db.transaction(() => {
            let assetsRestored = 0;
            let restoredBytes = 0;
            const now = Date.now();
            for (const descriptor of descriptors.values()) {
                const value = Buffer.allocUnsafe(descriptor.dataLength);
                readExactlySync(handle.fd, value, descriptor.dataPosition);
                validateHashedAsset(descriptor.name, value);
                const result = insert.run(`assets/${descriptor.name}`, value, now);
                if (result.changes > 0) {
                    assetsRestored += 1;
                    restoredBytes += value.length;
                }
            }
            return { assetsRestored, restoredBytes };
        });
        const restored = restore();

        return {
            referencedMissing: targets.size,
            assetsFound: descriptors.size,
            assetsUnavailable: targets.size - descriptors.size,
            assetsRestored: restored.assetsRestored,
            restoredBytes: restored.restoredBytes,
            skippedExisting: descriptors.size - restored.assetsRestored,
        };
    } finally {
        await handle.close();
    }
}

module.exports = {
    createBackupRestoreService,
    restoreMissingAssetsFromBackupFile,
    validateHashedAsset,
};

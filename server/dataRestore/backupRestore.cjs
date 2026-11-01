'use strict';

const { codes, createApiError } = require('../utils/apiErrors.cjs');
const { isInlayMediaType } = require('../../shared/inlayTypes.mjs');

// Full backup and selective asset restore engines.

const nodeCrypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const Database = require('../sqlite.cjs');
const { decode: decodeMessagePack } = require('msgpackr');
const { decryptAccountBackup } = require('./accountBackup.cjs');

const DEFAULT_MAX_ENTRY_NAME_BYTES = 1024;
const HASHED_ASSET_NAME = /^([0-9a-f]{64})\.[^/]+$/;
const PLUGIN_STORAGE_BACKUP_PREFIX = 'plugin-storage/';
const PLUGIN_STORAGE_BACKUP_MANIFEST = 'plugin-storage/_manifest';
const PLUGIN_STORAGE_BACKUP_NAMESPACES = new Set(['localStorage', 'localForage']);

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
    createBackupAndRotate,
    syncTrashRetention,
    prepareDatabaseProjection,
    replacePluginStorage,
    normalizeInlayExt,
    isSafeInlayId,
    decodeDataUri,
    ensureInlayDir,
    normalizeColdStorageStorageKey,
    normalizeColdStorageBackupBuffer,
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
        if (!name.startsWith('inlay/') || isInvalidBackupPathSegment(name)) return null;
        const suffix = name.slice('inlay/'.length);
        const dotIdx = suffix.lastIndexOf('.');
        const id = dotIdx > 0 ? suffix.slice(0, dotIdx) : suffix;
        if (!isSafeInlayId(id)) return null;
        return { id, ext: dotIdx > 0 ? suffix.slice(dotIdx + 1) : null };
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
            if (!parsed) {
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
        let hasPluginStorageSnapshot = false;
        let hasPluginStorageEntries = false;
        let bytesReceived = 0;
        const seenEntryNames = new Set();
        const seenStorageKeys = new Set();
        const stagedInlayPaths = new Map();
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
        let stagePluginStorage;
        let iterateStagedPluginStorage;
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

        function stagingInlayFilePath(id, ext) {
            const filePath = path.resolve(stagingDir, `${id}.${normalizeInlayExt(ext)}`);
            if (path.dirname(filePath) !== path.resolve(stagingDir)) {
                throw new Error(`Path escapes inlay staging directory: ${filePath}`);
            }
            return filePath;
        }
        const stagingSidecarPath = (id) => stagingInlayFilePath(id, 'meta.json');
        function writeStagingInlayFileSync(id, ext, buffer, info) {
            const normalizedExt = normalizeInlayExt(ext);
            const filePath = stagingInlayFilePath(id, normalizedExt);
            fsSync.writeFileSync(filePath, Buffer.from(buffer));
            stagedInlayPaths.set(id, filePath);
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
            stagingDb.exec(`
                CREATE TABLE plugin_storage_entries (
                    namespace TEXT NOT NULL,
                    storage_key TEXT NOT NULL,
                    payload BLOB NOT NULL,
                    owner TEXT,
                    PRIMARY KEY (namespace, storage_key)
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
            stagePluginStorage = stagingDb.prepare(
                'INSERT INTO plugin_storage_entries(namespace, storage_key, payload, owner) VALUES (?, ?, ?, ?)',
            );
            iterateStagedPluginStorage = stagingDb.prepare(
                'SELECT namespace, storage_key, payload, owner FROM plugin_storage_entries ORDER BY rowid',
            );
            for await (const chunk of dataSource) {
                bytesReceived += chunk.length;
                if (maxBytes > 0 && bytesReceived > maxBytes) {
                    throw createApiError(codes.BACKUP_TOO_LARGE, 413, { maxBytes });
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
                            if (!isInlayMediaType(type)) return;
                            const ext = normalizeInlayExt(parsed?.ext);
                            const buffer = decodeDataUri(parsed?.data).buffer;
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
                        assetsRestored += 1;
                    } else if (inlaySidecar) {
                        const parsed = JSON.parse(data.toString('utf-8'));
                        explicitSidecarMap.set(inlaySidecar.id, parsed);
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
                    } else if (name === 'encryption.risudat') {
                        encryptionMarker = Buffer.from(data);
                    } else if (name === 'database.risudat') {
                        databaseRaw = Buffer.from(data);
                    } else if (name === PLUGIN_STORAGE_BACKUP_MANIFEST) {
                        let manifest;
                        try {
                            manifest = JSON.parse(data.toString('utf-8'));
                        } catch {
                            throw new Error('Invalid plugin storage backup manifest');
                        }
                        if (manifest?.version !== 1
                            || !Array.isArray(manifest.namespaces)
                            || manifest.namespaces.length !== PLUGIN_STORAGE_BACKUP_NAMESPACES.size
                            || new Set(manifest.namespaces).size !== manifest.namespaces.length
                            || manifest.namespaces.some((namespace) =>
                                !PLUGIN_STORAGE_BACKUP_NAMESPACES.has(namespace))) {
                            throw new Error('Unsupported plugin storage backup manifest');
                        }
                        hasPluginStorageSnapshot = true;
                    } else if (name.startsWith(PLUGIN_STORAGE_BACKUP_PREFIX)) {
                        const parts = name.split('/');
                        if (parts.length !== 3 || !PLUGIN_STORAGE_BACKUP_NAMESPACES.has(parts[1])) {
                            throw new Error(`Invalid plugin storage backup entry name: ${name}`);
                        }
                        const encodedKey = parts[2];
                        if (!/^[A-Za-z0-9_-]*$/.test(encodedKey)) {
                            throw new Error(`Invalid plugin storage backup key: ${name}`);
                        }
                        const keyBytes = Buffer.from(encodedKey, 'base64url');
                        if (keyBytes.toString('base64url') !== encodedKey) {
                            throw new Error(`Invalid plugin storage backup key: ${name}`);
                        }
                        const key = keyBytes.toString('utf-8');
                        if (!Buffer.from(key, 'utf-8').equals(keyBytes)) {
                            throw new Error(`Invalid UTF-8 plugin storage backup key: ${name}`);
                        }
                        let decoded;
                        try {
                            decoded = decodeMessagePack(data);
                        } catch {
                            throw new Error(`Invalid plugin storage backup payload: ${name}`);
                        }
                        if (!decoded || typeof decoded !== 'object'
                            || !(Buffer.isBuffer(decoded.value) || decoded.value instanceof Uint8Array)
                            || (decoded.owner !== undefined && typeof decoded.owner !== 'string')) {
                            throw new Error(`Invalid plugin storage backup payload: ${name}`);
                        }
                        try {
                            stagePluginStorage.run(
                                parts[1], key, Buffer.from(decoded.value), decoded.owner ?? null,
                            );
                        } catch (error) {
                            if (/UNIQUE|PRIMARY KEY/i.test(String(error?.message))) {
                                throw new Error(`Duplicate backup plugin storage key: ${parts[1]}/${encodedKey}`);
                            }
                            throw error;
                        }
                        hasPluginStorageEntries = true;
                    } else if (!name.startsWith('inlay_thumb/')) {
                        const storageKey = resolveBackupStorageKey(name);
                        const storageValue = storageKey.startsWith('coldstorage/')
                            ? normalizeColdStorageBackupBuffer(data, name)
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
            if (!hasPluginStorageSnapshot && hasPluginStorageEntries) {
                throw new Error('Plugin storage backup entries require a manifest');
            }
            const inlayMetadata = new Map([...legacyInlayInfoMap, ...explicitSidecarMap]);
            for (const [id, info] of inlayMetadata) {
                const filePath = stagedInlayPaths.get(id);
                if (!isInlayMediaType(info?.type ?? 'image')) {
                    if (filePath) {
                        fsSync.rmSync(filePath, { force: true });
                        assetsRestored -= 1;
                    }
                    fsSync.rmSync(stagingSidecarPath(id), { force: true });
                } else if (filePath || explicitSidecarMap.has(id)) {
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
            // Prepare against staged data; synchronous install() keeps relational
            // writes in the same transaction as the remaining replacement.
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
                    if (preparedDatabase.discardedStorageKeys?.has(row.key)) {
                        assetsRestored -= 1;
                        continue;
                    }
                    kvSet(row.key, row.value);
                }
                const installResult = preparedDatabase.install();
                if (installResult && typeof installResult.then === 'function') {
                    throw new TypeError('prepared database install() must be synchronous');
                }
                if (hasPluginStorageSnapshot) {
                    function* stagedPluginStorage() {
                        for (const row of iterateStagedPluginStorage.iterate()) {
                            yield {
                                namespace: row.namespace,
                                key: row.storage_key,
                                value: Buffer.from(row.payload),
                                ...(typeof row.owner === 'string' ? { owner: row.owner } : {}),
                            };
                        }
                    }
                    replacePluginStorage(stagedPluginStorage());
                }
            });
            replaceLiveState();
            restoreCommitted = true;
            await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});

            syncTrashRetention();

            const {
                coldStorageFailed = 0,
                pluginStorageColdFailed = 0,
                skippedSaveBlocks = [],
            } = preparedDatabase;

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
                    `[Backup Import] ${coldStorageFailed} cold storage reference(s) could not be restored`,
                );
            }
            if (pluginStorageColdFailed > 0) {
                logger.error(`[Backup Import] ${pluginStorageColdFailed} plugin storage item(s) could not be restored`);
            }
            return { assetsRestored, bytesReceived, coldStorageFailed, pluginStorageColdFailed, skippedSaveBlocks };
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
 * Restore only currently-missing assets from a local server backup.
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
};

'use strict';

const { installAssetBatchRoutes } = require('./batch.cjs');
const { binaryBodyParser } = require('../../binaryHttp.cjs');

const { logger } = require('../../logs/logs.cjs');
const { createFullChatStore, findStubFlagLossChats } = require('../../chatStore.cjs');
const { encodeRisuSaveLegacy, normalizeJSON, decodeRisuSave, calculateHash } = require('../../utils.cjs');
const { kvSet, kvGetUpdatedAt, kvGet, kvDel, kvList, kvCount, db: sqliteDb } = require('../../db.cjs');
const fs = require('fs/promises');
const { encodeInlayAsset, decodeInlayAsset } = require('../../../../src/ts/storage/inlayTransport.ts');
const path = require('path');
const { existsSync, createReadStream } = require('fs');
const { spawn } = require('child_process');
const nodeCrypto = require('crypto');
const { filterRemoteOnlyFolders, mergeRemoteFilteredDatabase } = require('../../remoteDatabaseFilter.cjs');
const { restoreGenerationOwnedMetadata } = require('../../revenant/generationInputMetadata.cjs');
const { applyPatch } = require('fast-json-patch');

function installAssetRoutes(app, {
    saveTimers,
    queueStorageOperation,
    storageState,
    bookmarkStore,
    ensureChatStore,
    reassembleFullDb,
    appDataStore,
    deleteInlayRawFile,
    deleteInlayVideoThumbnail,
    getInlaySidecarPath,
    readInlayFile,
    readInlaySidecar,
    readInlayLegacyInfo,
    getVips,
    getInlayFileInfo,
    getInlayVideoThumbnailPath,
    inlayVideoThumbnailDir,
    sessionAuthMiddleware,
    getMimeFromExt,
    resolveAssetPayload,
    checkAuth,
    ensureCanonicalStorage,
    MISSING_DATABASE_ETAG,
    isCloudflareTunnelRequest,
    computeBufferEtag,
    readInlayInfoPayload,
    listInlayFiles,
    requireSyncClientId,
    computeDatabaseEtagFromObject,
    normalizeInlayExt,
    writeInlayFile,
    writeInlaySidecar,
    normalizeLegacyDatabaseProjection,
    refreshCanonicalDatabaseCache,
    createBackupAndRotate,
    broadcastDatabaseInvalidated,
    enablePatchSync,
    findChatInternalFieldOps,
    currentPersistWarning,
    getSyncClientIdFromRequest,
    clearPersistFailure,
}) {
    installAssetBatchRoutes(app, {
        checkAuth, requireSyncClientId, readInlayInfoPayload, kvGet, kvSet,
        transaction: callback => sqliteDb.transaction(callback),
    });

    const SAVE_INTERVAL = 5000;

    function scheduleStorageOperation(key, operation) {
        if (saveTimers[key]) clearTimeout(saveTimers[key]);
        const timer = setTimeout(() => {
            if (saveTimers[key] !== timer) return;
            delete saveTimers[key];
            void queueStorageOperation(operation).catch(error => {
                logger.error(`[Storage] Scheduled operation failed for ${key}:`, error);
            });
        }, SAVE_INTERVAL);
        saveTimers[key] = timer;
    }

    function recordPersistFailure(error, source) {
        const message = String(error?.message || error || 'unknown error');
        const attemptedSize = typeof error?.attemptedSize === 'number' ? error.attemptedSize : null;
        // Preserve timestamp when the failure is identical to the last one — every
        // debounce cycle re-records the same failure, and clients dedupe by ts.
        // Without this guard a fresh ts every 5s would re-fire the toast.
        if (storageState.lastPersistFailure
            && storageState.lastPersistFailure.source === source
            && storageState.lastPersistFailure.message === message
            && storageState.lastPersistFailure.attemptedSize === attemptedSize) {
            return;
        }
        storageState.lastPersistFailure = {
            timestamp: Date.now(),
            message,
            attemptedSize,
            source,
        };
    }

    function pruneBookmarksToFullChatStore() {
        if (!storageState.fullChatStore) return 0;
        return bookmarkStore.pruneInvalid((entry) => storageState.fullChatStore
            .get(entry.characterId)
            ?.get(entry.chatId)
            ?.message
            ?.some(message => message?.chatId === entry.messageId));
    }

    function initChatStore(dbObj) {
        const bookmarkMigration = bookmarkStore.migrateLegacyDatabase(dbObj);
        storageState.fullChatStore = createFullChatStore(dbObj);
        if (bookmarkMigration.migrated) pruneBookmarksToFullChatStore();
        return bookmarkMigration;
    }

    async function persistDbCacheWithChats(filePath, decodedKey) {
        const strippedDb = storageState.dbCache[filePath];
        if (!strippedDb) return;
        if (decodedKey !== 'database/database.bin') {
            const data = Buffer.from(encodeRisuSaveLegacy(strippedDb));
            kvSet(decodedKey, data);
            return;
        }
        await ensureChatStore();
        const fullDb = reassembleFullDb(strippedDb);

        // Disk protection guard: abort persist when reassemble produced metadata-only
        // chats. Writing them would lock the loss in (next /api/read returns the
        // stripped chat with no `_stub`, so hydration never re-merges fullChatStore).
        // Invalidate dbCache so the next request re-reads from disk and rebuilds a
        // consistent stub view; client receives 409 on next /api/patch via hash mismatch.
        if (decodedKey === 'database/database.bin') {
            const losses = findStubFlagLossChats(fullDb);
            if (losses.length > 0) {
                const sample = losses.slice(0, 3).map(l => `${l.chaId}/${l.chatId ?? l.chatIndex}`).join(', ');
                const err = new Error(
                    `persist aborted: ${losses.length} chat(s) lost _stub flag without upgrade — `
                    + `would silently strip messages on disk. sample=[${sample}]`
                );
                recordPersistFailure(err, 'persistDbCacheWithChats:stub-flag-loss');
                delete storageState.dbCache[filePath];
                throw err;
            }
        }

        try {
            appDataStore.syncStartupProjection(strippedDb);
        } catch (err) {
            throw err;
        }
        // Refresh fullChatStore from the persisted snapshot so subsequent
        // /api/chat-content GETs return the same metadata (folderId, modules)
        // that just hit disk. Without this, PATCH-only clears of stub fields
        // leave fullChatStore holding stale fullChat objects, and hydration
        // would resurrect the cleared values until the next /api/read.
        initChatStore(appDataStore.exportProjection({ includeMessages: true }));
        storageState.dbCache[filePath] = appDataStore.exportProjection({ includeMessages: false });
    }

    const hexRegex = /^[0-9a-fA-F]+$/;

    async function deleteInlayFile(id) {
        await deleteInlayRawFile(id);
        await deleteInlayVideoThumbnail(id);
        await fs.unlink(getInlaySidecarPath(id)).catch(() => {});
    }

    async function readInlayAssetPayload(id) {
        const file = await readInlayFile(id);
        if (!file) return null;
        const sidecar = (await readInlaySidecar(id)) || (await readInlayLegacyInfo(id));
        const info = {
            ext: sidecar?.ext || file.ext,
            name: sidecar?.name || id,
            type: sidecar?.type || 'image',
            height: sidecar?.height,
            width: sidecar?.width,
        };
        return Buffer.from(encodeInlayAsset({ ...info, mime: file.mime }, file.buffer).buffer);
    }

    function isHex(str) {
        return hexRegex.test(str.toUpperCase().trim()) || str === '__password';
    }

    const THUMB_SHORT_SIDE = 320;

    const THUMB_LONG_SIDE = 640;

    const THUMB_QUALITY = 75;

    const THUMB_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

    const videoThumbnailJobs = new Map();

    async function generateThumbnail(buffer) {
        const vips = await getVips()
        const source = vips.Image.newFromBuffer(buffer)
        let rotated = null
        let img = null
        try {
            rotated = source.autorot()
            const landscape = rotated.width >= rotated.height
            const targetWidth = landscape ? THUMB_LONG_SIDE : THUMB_SHORT_SIDE
            const targetHeight = landscape ? THUMB_SHORT_SIDE : THUMB_LONG_SIDE
            const scale = Math.min(targetWidth / rotated.width, targetHeight / rotated.height, 1)
            img = scale < 1
                ? rotated.resize(scale, { kernel: vips.Kernel.lanczos3 })
                : rotated
            const out = img.writeToBuffer('.webp', { Q: THUMB_QUALITY })
            return Buffer.from(out);
        } finally {
            if (img && img !== rotated) img.delete()
            if (rotated) rotated.delete()
            source.delete()
        }
    }

    function extractVideoThumbnailFrame(inputPath, outputPath) {
        const bundledExecutable = path.join(
            process.cwd(),
            'bin',
            process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
        )
        const executable = process.env.RISU_FFMPEG_PATH || (
            existsSync(bundledExecutable) ? bundledExecutable : 'ffmpeg'
        )

        return new Promise((resolve) => {
            const child = spawn(executable, [
                '-hide_banner',
                '-loglevel', 'error',
                '-ss', '0.1',
                '-i', inputPath,
                '-map', '0:v:0',
                '-frames:v', '1',
                '-an',
                '-sn',
                '-c:v', 'png',
                '-y',
                outputPath,
            ], {
                stdio: 'ignore',
                windowsHide: true,
            })
            let settled = false
            const finish = (success) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                resolve(success)
            }
            const timeout = setTimeout(() => {
                child.kill('SIGKILL')
                finish(false)
            }, 30_000)
            child.once('error', () => finish(false))
            child.once('close', (code) => finish(code === 0))
        })
    }

    async function ensureInlayVideoThumbnail(id) {
        const existingJob = videoThumbnailJobs.get(id)
        if (existingJob) return await existingJob

        const job = (async () => {
            const [source, sidecar] = await Promise.all([
                getInlayFileInfo(id),
                readInlaySidecar(id),
            ])
            if (!source || sidecar?.type !== 'video') return null

            const thumbnailPath = getInlayVideoThumbnailPath(id)
            try {
                const thumbnailStat = await fs.stat(thumbnailPath)
                if (thumbnailStat.mtimeMs >= source.mtimeMs) {
                    return { filePath: thumbnailPath, mtimeMs: thumbnailStat.mtimeMs }
                }
            } catch {
                // Generate a missing or stale thumbnail below.
            }

            await fs.mkdir(inlayVideoThumbnailDir, { recursive: true })
            const temporaryBase = `${id}.${process.pid}.${nodeCrypto.randomBytes(6).toString('hex')}`
            const framePath = path.join(
                inlayVideoThumbnailDir,
                `${temporaryBase}.frame.png`,
            )
            const temporaryThumbnailPath = path.join(
                inlayVideoThumbnailDir,
                `${temporaryBase}.tmp.webp`,
            )
            const extracted = await extractVideoThumbnailFrame(source.filePath, framePath)
            if (!extracted) {
                await fs.unlink(framePath).catch(() => {})
                return null
            }

            try {
                const frame = await fs.readFile(framePath)
                const thumbnail = await generateThumbnail(frame)
                await fs.writeFile(temporaryThumbnailPath, thumbnail)
                await fs.rename(temporaryThumbnailPath, thumbnailPath)
                const thumbnailStat = await fs.stat(thumbnailPath)
                return { filePath: thumbnailPath, mtimeMs: thumbnailStat.mtimeMs }
            } catch {
                return null
            } finally {
                await Promise.allSettled([
                    fs.unlink(framePath),
                    fs.unlink(temporaryThumbnailPath),
                ])
            }
        })().finally(() => {
            videoThumbnailJobs.delete(id)
        })

        videoThumbnailJobs.set(id, job)
        return await job
    }

    function parseSingleByteRange(rangeHeader, size) {
        if (typeof rangeHeader !== 'string' || !rangeHeader.startsWith('bytes=')) return null
        if (!Number.isSafeInteger(size) || size <= 0) return false

        const spec = rangeHeader.slice('bytes='.length).trim()
        if (!spec || spec.includes(',')) return false

        const separator = spec.indexOf('-')
        if (separator === -1) return false

        const startText = spec.slice(0, separator).trim()
        const endText = spec.slice(separator + 1).trim()
        if (!startText && !endText) return false

        if (!startText) {
            const suffixLength = Number(endText)
            if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false
            return {
                start: Math.max(size - suffixLength, 0),
                end: size - 1,
            }
        }

        const start = Number(startText)
        const requestedEnd = endText ? Number(endText) : size - 1
        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(requestedEnd) ||
            start < 0 ||
            start >= size ||
            requestedEnd < start
        ) return false

        return {
            start,
            end: Math.min(requestedEnd, size - 1),
        }
    }

    function pipeFileResponse(res, filePath, options) {
        const stream = createReadStream(filePath, options)
        stream.on('error', (error) => {
            if (res.headersSent) res.destroy(error)
            else {
                res.removeHeader('Content-Length')
                res.removeHeader('Content-Range')
                res.status(500).end()
            }
        })
        return stream.pipe(res)
    }

    app.get('/api/asset/:hexKey', sessionAuthMiddleware, async (req, res) => {
        try {
            const key = Buffer.from(req.params.hexKey, 'hex').toString('utf-8')

            if (key.startsWith('inlay/')) {
                const id = key.slice('inlay/'.length)
                const file = await getInlayFileInfo(id)
                if (file) {
                    const etag = `"${Math.floor(file.mtimeMs)}"`
                    const cacheHeaders = {
                        'Content-Type': getMimeFromExt(file.ext),
                        'Cache-Control': 'public, max-age=31536000, immutable',
                        'ETag': etag,
                        'Accept-Ranges': 'bytes',
                    }
                    const rangeHeader = req.headers.range
                    if (!rangeHeader && req.headers['if-none-match'] === etag) {
                        return res.status(304).set(cacheHeaders).end()
                    }

                    const shouldUseRange = rangeHeader && (
                        !req.headers['if-range'] || req.headers['if-range'] === etag
                    )
                    const range = shouldUseRange
                        ? parseSingleByteRange(rangeHeader, file.size)
                        : null
                    if (range === false) {
                        return res.status(416).set({
                            ...cacheHeaders,
                            'Content-Range': `bytes */${file.size}`,
                        }).end()
                    }
                    if (range) {
                        res.status(206).set({
                            ...cacheHeaders,
                            'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`,
                            'Content-Length': String(range.end - range.start + 1),
                        })
                        if (req.method === 'HEAD') return res.end()
                        return pipeFileResponse(res, file.filePath, {
                            start: range.start,
                            end: range.end,
                        })
                    }

                    res.set({
                        ...cacheHeaders,
                        'Content-Length': String(file.size),
                    })
                    if (req.method === 'HEAD') return res.end()
                    return pipeFileResponse(res, file.filePath)
                }
                return res.status(404).set('Cache-Control', 'no-store').end()
            }

            if (key.startsWith('inlay_thumb/')) {
                const id = key.slice('inlay_thumb/'.length)
                const sidecar = await readInlaySidecar(id);
                if (!sidecar || sidecar.type !== 'image' || !THUMB_IMAGE_EXTS.has(sidecar.ext)) {
                    return res.status(404).end()
                }
                const file = await readInlayFile(id)
                if (!file) return res.status(404).set('Cache-Control', 'no-store').end()
                const etag = `"thumb-${Math.floor(file.mtimeMs)}"`
                if (req.headers['if-none-match'] === etag) {
                    return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
                }
                const thumb = await generateThumbnail(file.buffer)
                res.set({
                    'Content-Type': 'image/webp',
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'ETag': etag,
                })
                return res.send(thumb)
            }

            if (key.startsWith('inlay_video_thumb/')) {
                const id = key.slice('inlay_video_thumb/'.length)
                const thumbnail = await ensureInlayVideoThumbnail(id)
                if (!thumbnail) return res.status(404).set('Cache-Control', 'no-store').end()

                const stat = await fs.stat(thumbnail.filePath)
                const etag = `"video-thumb-${Math.floor(thumbnail.mtimeMs)}"`
                const cacheHeaders = {
                    'Content-Type': 'image/webp',
                    'Cache-Control': 'public, max-age=86400',
                    'ETag': etag,
                    'Content-Length': String(stat.size),
                }
                if (req.headers['if-none-match'] === etag) {
                    return res.status(304).set(cacheHeaders).end()
                }
                res.set(cacheHeaders)
                if (req.method === 'HEAD') return res.end()
                return pipeFileResponse(res, thumbnail.filePath)
            }

            // Fast-path 304: check updated_at BEFORE loading the blob.
            const updatedAt = kvGetUpdatedAt(key)
            if (updatedAt === null) return res.status(404).set('Cache-Control', 'no-store').end()

            const etag = `"${updatedAt}"`
            if (req.headers['if-none-match'] === etag) {
                return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
            }

            const data = kvGet(key)
            if (!data) return res.status(404).set('Cache-Control', 'no-store').end()

            const { binary, contentType } = resolveAssetPayload(key, data)
            res.set({
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=31536000, immutable',
                'ETag': etag,
            })
            res.send(binary)
        } catch (error) {
            logger.error('[Asset] Failed to serve asset:', error);
            res.status(500).end()
        }
    })

    app.get('/api/plugin-storage/startup-stats', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            await ensureCanonicalStorage();
            res.json(appDataStore.pluginStorageFootprint());
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/read', async (req, res, next) => {
        if(!await checkAuth(req, res)){
            return;
        }
        const filePath = req.headers['file-path'];
        if (!filePath) {
            console.log('no path')
            res.status(400).send({ error:'File path required' });
            return;
        }
        if(!isHex(filePath)){
            res.status(400).send({ error:'Invaild Path' });
            return;
        }
        try {
            const key = Buffer.from(filePath, 'hex').toString('utf-8');
            // database.bin is a virtual compatibility export. No live blob exists
            // in KV after migration, and the browser hot path uses /api/database.
            if (key === 'database/database.bin') {
                await ensureCanonicalStorage();
                if (!appDataStore.getState().initialized) {
                    storageState.dbEtag = MISSING_DATABASE_ETAG;
                    res.setHeader('x-db-etag', storageState.dbEtag);
                    return res.send();
                }
                let projection = appDataStore.exportProjection({ includeMessages: true });
                bookmarkStore.projectDatabaseCompatibility(projection);
                if (isCloudflareTunnelRequest(req)) {
                    projection = normalizeJSON(filterRemoteOnlyFolders(projection));
                }
                const value = Buffer.from(encodeRisuSaveLegacy(projection));
                storageState.dbEtag = computeBufferEtag(value);
                if (req.headers['if-none-match'] === storageState.dbEtag) {
                    return res.status(304).end();
                }
                res.setHeader('x-db-etag', storageState.dbEtag);
                res.setHeader('Content-Type', 'application/octet-stream');
                return res.send(value);
            }
            let value = null;
            if (key.startsWith('inlay/')) {
                value = await readInlayAssetPayload(key.slice('inlay/'.length));
            } else if (key.startsWith('inlay_info/')) {
                value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
            }
            if (value === null) {
                value = kvGet(key);
            }
            if (value === null) return res.send();
            res.setHeader('Content-Type', 'application/octet-stream');
            res.send(value);
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/remove', async (req, res, next) => {
        if(!await checkAuth(req, res)){
            return;
        }
        const filePath = req.headers['file-path'];
        if (!filePath) {
            res.status(400).send({ error:'File path required' });
            return;
        }
        if(!isHex(filePath)){
            res.status(400).send({ error:'Invaild Path' });
            return;
        }
        try {
            const key = Buffer.from(filePath, 'hex').toString('utf-8');
            if (key === 'database/database.bin') {
                return res.status(410).json({
                    error: 'database.bin is a virtual import/export projection and cannot be removed',
                    code: 'DATABASE_BIN_PROJECTION_ONLY',
                });
            }
            if (key.startsWith('inlay/')) {
                const id = key.slice('inlay/'.length)
                await deleteInlayFile(id)
                kvDel(key);
                kvDel(`inlay_thumb/${id}`);
                kvDel(`inlay_info/${id}`);
                return res.send({ success: true });
            }
            if (key.startsWith('inlay_info/')) {
                await fs.unlink(getInlaySidecarPath(key.slice('inlay_info/'.length))).catch(() => {});
            }
            kvDel(key);
            res.send({ success: true });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/list', async (req, res, next) => {
        if(!await checkAuth(req, res)){
            return;
        }
        try {
            const keyPrefix = req.headers['key-prefix'] || '';
            const requestedLimit = Number(req.headers['key-limit']);
            const requestedOffset = Number(req.headers['key-offset']);
            const listOptions = req.headers['key-order'] === 'updated-desc'
                && Number.isSafeInteger(requestedLimit)
                && requestedLimit > 0
                ? {
                    order: 'updated-desc',
                    limit: Math.min(requestedLimit, 5000),
                    offset: Number.isSafeInteger(requestedOffset) && requestedOffset > 0
                        ? requestedOffset
                        : 0,
                }
                : undefined;
            let data;
            if (keyPrefix === 'inlay/') {
                const fileKeys = (await listInlayFiles()).map((entry) => `inlay/${entry.id}`);
                data = [...new Set([
                    ...fileKeys,
                    ...kvList('inlay/'),
                ])];
            } else {
                data = kvList(keyPrefix || undefined, listOptions);
            }
            res.send({
                success: true,
                content: data,
                total: keyPrefix === 'inlay/' ? data.length : kvCount(keyPrefix || undefined),
            });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/write', binaryBodyParser('2gb'), async (req, res, next) => {
        if(!await checkAuth(req, res)){
            return;
        }
        if (!requireSyncClientId(req, res)) return;
        const filePath = req.headers['file-path'];
        const fileContent = req.body;
        if (!filePath || !fileContent) {
            res.status(400).send({ error:'File path required' });
            return;
        }
        if(!isHex(filePath)){
            res.status(400).send({ error:'Invaild Path' });
            return;
        }
        try {
            await queueStorageOperation(async () => {
                const key = Buffer.from(filePath, 'hex').toString('utf-8');
                let databaseForEtag = null;

                // ETag conflict detection for database.bin
                if (key === 'database/database.bin') {
                    const ifMatch = req.headers['x-if-match'];
                    await ensureCanonicalStorage();
                    let currentEtag = MISSING_DATABASE_ETAG;
                    if (appDataStore.getState().initialized) {
                        let currentDb = appDataStore.exportProjection({ includeMessages: true });
                        bookmarkStore.projectDatabaseCompatibility(currentDb);
                        if (isCloudflareTunnelRequest(req)) {
                            currentDb = normalizeJSON(filterRemoteOnlyFolders(currentDb));
                        }
                        currentEtag = computeDatabaseEtagFromObject(currentDb);
                    }
                    if (appDataStore.getState().initialized && !ifMatch) {
                        res.status(428).send({
                            error: 'x-if-match is required for compatibility database import',
                            code: 'DATABASE_IMPORT_PRECONDITION_REQUIRED',
                            currentEtag,
                        });
                        return;
                    }
                    if (ifMatch && ifMatch !== currentEtag) {
                        res.status(409).send({
                            error: 'ETag mismatch - concurrent modification detected',
                            currentEtag
                        });
                        return;
                    }
                }

                if (key.startsWith('inlay/')) {
                    const id = key.slice('inlay/'.length)
                    let decoded;
                    try {
                        decoded = decodeInlayAsset(fileContent);
                    } catch (error) {
                        return res.status(400).send({ error: error.message });
                    }
                    const { metadata: parsed, bytes: buffer } = decoded;
                    const type = parsed.type;
                    const ext = normalizeInlayExt(parsed.ext);
                    await writeInlayFile(id, ext, buffer, {
                        ext,
                        name: typeof parsed?.name === 'string' ? parsed.name : id,
                        type,
                        height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                        width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                    });
                    kvDel(key);
                    kvDel(`inlay_thumb/${id}`);
                    kvDel(`inlay_info/${id}`);
                } else if (key.startsWith('inlay_info/')) {
                    const id = key.slice('inlay_info/'.length)
                    const parsed = JSON.parse(Buffer.from(fileContent).toString('utf-8'));
                    await writeInlaySidecar(id, parsed);
                    kvDel(key);
                } else if (key === 'database/database.bin') {
                    // Explicit compatibility import. Ordinary browser saves use
                    // PATCH /api/database and never pass through this codec.
                    try {
                        let incomingDb = normalizeLegacyDatabaseProjection(
                            await decodeRisuSave(fileContent),
                        ).database;
                        const currentDb = appDataStore.getState().initialized
                            ? appDataStore.exportProjection({ includeMessages: true })
                            : { characters: [] };
                        if (isCloudflareTunnelRequest(req)) {
                            incomingDb = mergeRemoteFilteredDatabase(currentDb, incomingDb);
                            restoreGenerationOwnedMetadata(incomingDb, currentDb);
                        }
                        const stubOnly = [];
                        for (const character of incomingDb.characters ?? []) {
                            for (const chat of character?.chats ?? []) {
                                if (chat?._stub === true && !Array.isArray(chat.message)) {
                                    stubOnly.push(`${character.chaId}/${chat.id}`);
                                }
                            }
                        }
                        if (stubOnly.length > 0) {
                            return res.status(400).json({
                                error: 'Compatibility import requires full chat content',
                                chats: stubOnly.slice(0, 5),
                            });
                        }
                        sqliteDb.transaction(() => {
                            if (!isCloudflareTunnelRequest(req)) {
                                bookmarkStore.replaceDatabaseCompatibility(incomingDb);
                            } else {
                                // A remote compatibility import cannot alter the
                                // server-owned bookmark catalog, and compatibility
                                // fields must never leak into canonical chat bodies.
                                bookmarkStore.stripDatabaseCompatibility(incomingDb);
                            }
                            appDataStore.replaceFromProjection(incomingDb, {
                                expectedRevision: appDataStore.getState().revision,
                            });
                        })();
                        databaseForEtag = appDataStore.exportProjection({ includeMessages: true });
                        bookmarkStore.projectDatabaseCompatibility(databaseForEtag);
                    } catch (e) {
                        logger.error('[Write] Compatibility database import failed:', e);
                        if (e?.code === 'UNSUPPORTED_REMOTE_SAVE') {
                            res.status(400).json({ error: e.message, code: e.code });
                        } else {
                            res.status(500).json({ error: 'Database import failed' });
                        }
                        return;
                    }
                } else {
                    kvSet(key, fileContent);
                }

                // Update ETag, backup, and invalidate cache after database.bin write
                if (key === 'database/database.bin') {
                    refreshCanonicalDatabaseCache({ invalidateChats: true });
                    // ETag based on the stripped version visible to this client.
                    const visibleForEtag = isCloudflareTunnelRequest(req)
                        ? normalizeJSON(filterRemoteOnlyFolders(databaseForEtag))
                        : databaseForEtag;
                    storageState.dbEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(visibleForEtag)));
                    createBackupAndRotate();
                    broadcastDatabaseInvalidated(req);
                }

                res.send({
                    success: true,
                    etag: key === 'database/database.bin' ? storageState.dbEtag : undefined
                });
            });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/patch', async (req, res, next) => {
        if (!enablePatchSync) {
            res.status(404).send({ error: 'Patch sync is not enabled' });
            return;
        }
        if(!await checkAuth(req, res)){
            return;
        }
        if (!requireSyncClientId(req, res)) return;
        const filePath = req.headers['file-path'];
        const patch = req.body.patch;
        const expectedHash = req.body.expectedHash;

        if (!filePath || !patch || !expectedHash) {
            res.status(400).send({ error: 'File path, patch, and expected hash required' });
            return;
        }
        if (!isHex(filePath)) {
            res.status(400).send({ error: 'Invaild Path' });
            return;
        }

        let patchStage = 'load';
        try {
            await queueStorageOperation(async () => {
                const decodedKey = Buffer.from(filePath, 'hex').toString('utf-8');
                if (decodedKey === 'database/database.bin') {
                    res.status(410).json({
                        error: 'database.bin patch sync was replaced by PATCH /api/database',
                        code: 'DATABASE_BIN_PROJECTION_ONLY',
                    });
                    return;
                }

                // Load database into memory if not already cached
                // For database.bin, cache holds the STRIPPED version (stubs only)
                if (!storageState.dbCache[filePath]) {
                    const fileContent = kvGet(decodedKey);
                    if (fileContent) {
                        storageState.dbCache[filePath] = normalizeJSON(await decodeRisuSave(fileContent));
                    } else {
                        storageState.dbCache[filePath] = {};
                    }
                }

                // Reject patch ops that touch chat-internal fields. Lazy loading
                // strips chats to stubs in dbCache; the only legitimate chat ops
                // are allowlisted stub metadata (see STUB_METADATA_FIELDS)
                // or whole-chat add/replace/remove. Field-level ops on chats —
                // particularly remove of message/hypaV3Data/scriptstate/etc —
                // strip the `_stub` flag and cause silent on-disk data loss when
                // reassembleFullDb later sees the metadata-only chat. Reject as
                // 409 so the client falls through to a full write and rebases its
                // patcher baseline. See findStubFlagLossChats for the disk-side
                // partner guard.
                const chatInternalOps = decodedKey === 'database/database.bin'
                    ? findChatInternalFieldOps(patch)
                    : [];
                if (chatInternalOps.length > 0) {
                    const sample = chatInternalOps.slice(0, 5).map(v => `${v.op} ${v.path}`).join(', ');
                    logger.warn(
                        `[Patch] Rejected ${chatInternalOps.length} chat-internal field op(s) `
                        + `(would corrupt lazy-loaded chats): ${sample}`
                    );
                    let currentEtag;
                    try {
                        currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(storageState.dbCache[filePath])));
                        storageState.dbEtag = currentEtag;
                    } catch {}
                    res.status(409).send({
                        error: 'Patch rejected: chat-internal field ops not allowed for lazy-loaded chats',
                        code: 'CHAT_GUARD_REJECTED',
                        chatGuardRejected: true,
                        currentEtag,
                    });
                    return;
                }

                const remoteFilteredDb = decodedKey === 'database/database.bin' && isCloudflareTunnelRequest(req)
                    ? normalizeJSON(filterRemoteOnlyFolders(storageState.dbCache[filePath]))
                    : null;
                const patchBaseline = remoteFilteredDb ?? storageState.dbCache[filePath];
                patchStage = 'hash';
                const serverHash = calculateHash(patchBaseline).toString(16);

                // JSON Patch identity: no operation means no compare-and-swap and
                // no write. Older open clients may still submit these while a
                // server-owned generation commit advances the database, so return
                // the current view without manufacturing a hash conflict.
                if (Array.isArray(patch) && patch.length === 0) {
                    let currentEtag;
                    if (decodedKey === 'database/database.bin') {
                        currentEtag = computeBufferEtag(Buffer.from(
                            encodeRisuSaveLegacy(patchBaseline)
                        ));
                        storageState.dbEtag = currentEtag;
                    }
                    const responsePayload = {
                        success: true,
                        appliedOperations: 0,
                        etag: currentEtag,
                    };
                    const persistWarning = currentPersistWarning();
                    if (persistWarning) responsePayload.persistWarning = persistWarning;
                    res.send(responsePayload);
                    return;
                }

                if (expectedHash !== serverHash) {
                    const patchPaths = Array.isArray(patch)
                        ? patch.slice(0, 8).map(operation =>
                            `${String(operation?.op || '?')} ${String(operation?.path || '?')}`)
                        : [];
                    logger.warn(
                        `[Patch] Hash mismatch for ${decodedKey}: `
                        + `expected=${expectedHash}, server=${serverHash}, `
                        + `client=${String(getSyncClientIdFromRequest(req) || 'none')}, `
                        + `ops=[${patchPaths.join(', ')}]`
                    );
                    let currentEtag = undefined;
                    if (decodedKey === 'database/database.bin') {
                        const visibleDb = remoteFilteredDb ?? storageState.dbCache[filePath];
                        // Keep a hash mismatch as a recoverable 409 even if the
                        // best-effort current ETag cannot be encoded.
                        try {
                            currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(visibleDb)));
                            storageState.dbEtag = currentEtag;
                        } catch {}
                    }
                    res.status(409).send({
                        error: 'Hash mismatch - data out of sync',
                        currentEtag
                    });
                    return;
                }

                // A JSON round-trip builds one giant string and reaches V8's string
                // size ceiling on large databases. The cached value is already a
                // normalized plain-data graph, so structuredClone preserves the
                // rollback boundary without that intermediate allocation.
                patchStage = 'clone';
                const snapshot = structuredClone(patchBaseline);
                patchStage = 'apply';
                let result;
                try {
                    result = applyPatch(snapshot, patch, true);
                } catch (patchErr) {
                    // Invalidate corrupted cache entry to force reload on next request
                    delete storageState.dbCache[filePath];
                    throw patchErr;
                }
                storageState.dbCache[filePath] = remoteFilteredDb
                    ? normalizeJSON(mergeRemoteFilteredDatabase(storageState.dbCache[filePath], snapshot))
                    : snapshot;

                // Schedule save to KV (debounced) — merge full chats back for database.bin
                scheduleStorageOperation(filePath, async () => {
                    try {
                        if (decodedKey === 'database/database.bin') {
                            await persistDbCacheWithChats(filePath, decodedKey);
                        } else {
                            const data = Buffer.from(encodeRisuSaveLegacy(storageState.dbCache[filePath]));
                            try {
                                kvSet(decodedKey, data);
                            } catch (err) {
                                if (err && typeof err === 'object') {
                                    try { err.attemptedSize = data.length; } catch {}
                                }
                                throw err;
                            }
                        }
                        // Persist succeeded — clear before backup so a backup-only
                        // failure isn't attributed to data loss.
                        clearPersistFailure();
                        if (decodedKey === 'database/database.bin') {
                            try {
                                createBackupAndRotate();
                            } catch (backupErr) {
                                logger.warn(`[Patch] Backup rotation failed for ${decodedKey}:`, backupErr);
                            }
                        }
                    } catch (error) {
                        logger.error(`[Patch] Error saving ${decodedKey}:`, error);
                        recordPersistFailure(error, `patch:${decodedKey}`);
                    }
                });

                // Update ETag after successful patch (based on stripped version)
                patchStage = 'etag';
                if (decodedKey === 'database/database.bin') {
                    const visibleDb = remoteFilteredDb
                        ? normalizeJSON(filterRemoteOnlyFolders(storageState.dbCache[filePath]))
                        : storageState.dbCache[filePath];
                    storageState.dbEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(visibleDb)));
                }

                const responsePayload = {
                    success: true,
                    appliedOperations: result.length,
                    etag: decodedKey === 'database/database.bin' ? storageState.dbEtag : undefined,
                };
                const persistWarning = currentPersistWarning();
                if (persistWarning) {
                    responsePayload.persistWarning = persistWarning;
                }
                if (decodedKey === 'database/database.bin') {
                    broadcastDatabaseInvalidated(req);
                }
                res.send(responsePayload);
            });
        } catch (error) {
            const decodedKeyForLog = isHex(filePath) ? Buffer.from(filePath, 'hex').toString('utf-8') : filePath;
            logger.error(
                `[Patch] Error applying patch to ${decodedKeyForLog} `
                + `(stage=${patchStage}, ops=${Array.isArray(patch) ? patch.length : '?'}): `
                + `${error?.name}: ${error?.message}`,
                error?.stack
            );
            res.status(500).send({
                error: 'Patch application failed: ' + (error && error.message ? error.message : error)
            });
        }
    });
}

module.exports = { installAssetRoutes };

'use strict';

const { withTransaction } = require('../../sqlite.cjs');
const { installAssetBatchRoutes } = require('./batch.cjs');
const { binaryBodyParser } = require('../../utils/binaryHttp.cjs');

const { logger } = require('../../logs/logs.cjs');
const { encodeRisuSaveLegacy, decodeRisuSave } = require('../../utils/risuSave.cjs');
const { kvSet, kvGetUpdatedAt, kvGet, kvDel, kvList, kvCount, db: sqliteDb } = require('../../db.cjs');
const fs = require('fs/promises');
const { createReadStream } = require('fs');
const { filterRemoteOnlyFolders, mergeRemoteFilteredDatabase } = require('../../remoteDatabaseFilter.cjs');
const { restoreGenerationOwnedMetadata } = require('../../revenant/generationInputMetadata.cjs');
const { codes, sendApiError } = require('../../utils/apiErrors.cjs');
const { getMimeFromExt, resolveAssetPayload } = require('../../utils/mime.cjs');

function installAssetRoutes(app, {
    queueStorageOperation,
    bookmarkStore,
    appDataStore,
    inlayService,
    sessionAuthMiddleware,
    checkAuth,
    ensureCanonicalStorage,
    MISSING_DATABASE_ETAG,
    isCloudflareTunnelRequest,
    computeBufferEtag,
    requireSyncClientId,
    computeDatabaseEtagFromObject,
    normalizeLegacyDatabaseProjection,
    syncTrashRetention,
    createBackupAndRotate,
    broadcastDatabaseInvalidated,
}) {
    const {
        deleteInlayFile,
        decodeInlayAsset,
        getInlaySidecarPath,
        readInlayInfoPayload,
        readInlayAssetPayload,
        getInlayFileInfo,
        ensureThumbnail,
        listInlayFiles,
        normalizeInlayExt,
        writeInlayFile,
        writeInlaySidecar,
    } = inlayService;

    installAssetBatchRoutes(app, {
        checkAuth, requireSyncClientId, readInlayInfoPayload, kvGet, kvSet,
        transaction: fn => withTransaction(sqliteDb, fn),
    });

    const hexRegex = /^[0-9a-fA-F]+$/;

    function isHex(str) {
        return hexRegex.test(str.toUpperCase().trim()) || str === '__password';
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
        res.once('close', () => stream.destroy())
        stream.on('error', (error) => {
            if (res.headersSent) res.destroy(error)
            else {
                res.removeHeader('Content-Length')
                res.removeHeader('Content-Range')
                res.removeHeader('Content-Disposition')
                res.status(500).end()
            }
        })
        return stream.pipe(res)
    }

    app.get('/api/asset/:hexKey', sessionAuthMiddleware, async (req, res) => {
        try {
            const key = Buffer.from(req.params.hexKey, 'hex').toString('utf-8')
            const download = req.query.download === '1'
            const filename = typeof req.query.filename === 'string' ? req.query.filename : ''

            if (key.startsWith('inlay/')) {
                const id = key.slice('inlay/'.length)
                const file = await getInlayFileInfo(id)
                if (file) {
                    if (download) res.attachment(filename || `${id}.${file.ext}`)
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

            const thumbnailAsset = key.startsWith('inlay_thumb/')
                ? { id: key.slice('inlay_thumb/'.length), type: 'image' }
                : key.startsWith('inlay_video_thumb/')
                    ? { id: key.slice('inlay_video_thumb/'.length), type: 'video' }
                    : null
            if (thumbnailAsset) {
                const thumbnail = await ensureThumbnail(thumbnailAsset.id, thumbnailAsset.type)
                if (!thumbnail) return res.status(404).set('Cache-Control', 'no-store').end()
                if (download) res.attachment(filename || `${thumbnailAsset.id}.webp`)

                const isVideo = thumbnailAsset.type === 'video'
                const etagPrefix = isVideo ? 'video-thumb' : 'thumb'
                const cacheHeaders = {
                    'Content-Type': 'image/webp',
                    'Cache-Control': isVideo
                        ? 'public, max-age=86400'
                        : 'public, max-age=31536000, immutable',
                    'ETag': `"${etagPrefix}-${Math.floor(thumbnail.stat.mtimeMs)}"`,
                    'Content-Length': String(thumbnail.stat.size),
                }
                if (req.headers['if-none-match'] === cacheHeaders.ETag) {
                    return res.status(304).set(cacheHeaders).end()
                }
                res.set(cacheHeaders)
                if (req.method === 'HEAD') return res.end()
                return pipeFileResponse(res, thumbnail.filePath)
            }

            // Avoid loading the blob when the client's cache is current.
            const updatedAt = kvGetUpdatedAt(key)
            if (updatedAt === null) return res.status(404).set('Cache-Control', 'no-store').end()

            const etag = `"${updatedAt}"`
            if (req.headers['if-none-match'] === etag) {
                return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
            }

            const data = kvGet(key)
            if (!data) return res.status(404).set('Cache-Control', 'no-store').end()

            const { binary, contentType } = resolveAssetPayload(key, data)
            if (download) res.attachment(filename || key.split('/').pop())
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

    app.get('/api/plugin-storage/startup-stats', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        await ensureCanonicalStorage();
        res.json(appDataStore.pluginStorageFootprint());
    });

    app.get('/api/read', async (req, res) => {
        if(!await checkAuth(req, res)){
            return;
        }
        const filePath = req.headers['file-path'];
        if (!filePath) {
            console.log('no path')
            sendApiError(res, 400, codes.INVALID_FILE_PATH);
            return;
        }
        if(!isHex(filePath)){
            sendApiError(res, 400, codes.INVALID_FILE_PATH);
            return;
        }
        const key = Buffer.from(filePath, 'hex').toString('utf-8');
        // database.bin is a compatibility projection of canonical storage.
        if (key === 'database/database.bin') {
            await ensureCanonicalStorage();
            if (!appDataStore.getState().initialized) {
                res.setHeader('x-db-etag', MISSING_DATABASE_ETAG);
                return res.send();
            }
            let projection = appDataStore.exportProjection({ includeMessages: true });
            bookmarkStore.projectDatabaseCompatibility(projection);
            if (isCloudflareTunnelRequest(req)) {
                projection = filterRemoteOnlyFolders(projection);
            }
            const value = Buffer.from(encodeRisuSaveLegacy(projection));
            const etag = computeBufferEtag(value);
            if (req.headers['if-none-match'] === etag) {
                return res.status(304).end();
            }
            res.setHeader('x-db-etag', etag);
            res.setHeader('Content-Type', 'application/octet-stream');
            return res.send(value);
        }
        let value = null;
        if (key.startsWith('inlay/')) {
            value = await readInlayAssetPayload(key.slice('inlay/'.length));
        } else if (key.startsWith('inlay_info/')) {
            value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
        } else {
            value = kvGet(key);
        }
        if (value === null) return res.send();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(value);
    });

    app.get('/api/remove', async (req, res) => {
        if(!await checkAuth(req, res)){
            return;
        }
        const filePath = req.headers['file-path'];
        if (!filePath) {
            sendApiError(res, 400, codes.INVALID_FILE_PATH);
            return;
        }
        if(!isHex(filePath)){
            sendApiError(res, 400, codes.INVALID_FILE_PATH);
            return;
        }
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
    });

    app.get('/api/list', async (req, res) => {
        if(!await checkAuth(req, res)){
            return;
        }
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
            data = [...new Set((await listInlayFiles()).map((entry) => `inlay/${entry.id}`))];
        } else {
            data = kvList(keyPrefix || undefined, listOptions);
        }
        res.send({
            success: true,
            content: data,
            total: keyPrefix === 'inlay/' ? data.length : kvCount(keyPrefix || undefined),
        });
    });

    app.post('/api/write', binaryBodyParser('2gb'), async (req, res) => {
        if(!await checkAuth(req, res)){
            return;
        }
        if (!requireSyncClientId(req, res)) return;
        const filePath = req.headers['file-path'];
        const fileContent = req.body;
        if (!filePath || !fileContent) {
            sendApiError(res, 400, codes.INVALID_FILE_PATH);
            return;
        }
        if(!isHex(filePath)){
            sendApiError(res, 400, codes.INVALID_FILE_PATH);
            return;
        }
        await queueStorageOperation(async () => {
            const key = Buffer.from(filePath, 'hex').toString('utf-8');
            let databaseForEtag = null;

            if (key === 'database/database.bin') {
                const ifMatch = req.headers['x-if-match'];
                await ensureCanonicalStorage();
                let currentEtag = MISSING_DATABASE_ETAG;
                if (appDataStore.getState().initialized) {
                    let currentDb = appDataStore.exportProjection({ includeMessages: true });
                    bookmarkStore.projectDatabaseCompatibility(currentDb);
                    if (isCloudflareTunnelRequest(req)) {
                        currentDb = filterRemoteOnlyFolders(currentDb);
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
                // Compatibility import; ordinary saves use PATCH /api/database.
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
                    // A chat without a message list is not full content, whatever
                    // it claims to be. Importing it would replace the stored body
                    // with an empty one, so reject the whole import instead.
                    const withoutBody = [];
                    for (const character of incomingDb.characters ?? []) {
                        for (const chat of character?.chats ?? []) {
                            if (!Array.isArray(chat?.message)) {
                                withoutBody.push(`${character.chaId}/${chat?.id}`);
                            }
                        }
                    }
                    if (withoutBody.length > 0) {
                        return res.status(400).json({
                            error: 'Compatibility import requires full chat content',
                            chats: withoutBody.slice(0, 5),
                        });
                    }
                    withTransaction(sqliteDb, () => {
                        if (!isCloudflareTunnelRequest(req)) {
                            bookmarkStore.replaceDatabaseCompatibility(incomingDb);
                        } else {
                            // Remote imports cannot replace server-owned bookmarks.
                            bookmarkStore.stripDatabaseCompatibility(incomingDb);
                        }
                        appDataStore.replaceFromProjection(incomingDb, {
                            expectedRevision: appDataStore.getState().revision,
                        });
                    });
                    databaseForEtag = appDataStore.exportProjection({ includeMessages: true });
                    bookmarkStore.projectDatabaseCompatibility(databaseForEtag);
                } catch (e) {
                    logger.error('[Write] Compatibility database import failed:', e);
                    if (e?.code === codes.UNSUPPORTED_REMOTE_SAVE) {
                        res.status(400).json({ error: e.message, code: e.code });
                    } else {
                        res.status(500).json({ error: 'Database import failed' });
                    }
                    return;
                }
            } else {
                kvSet(key, fileContent);
            }

            let etag;
            if (key === 'database/database.bin') {
                syncTrashRetention();
                const visibleForEtag = isCloudflareTunnelRequest(req)
                    ? filterRemoteOnlyFolders(databaseForEtag)
                    : databaseForEtag;
                etag = computeDatabaseEtagFromObject(visibleForEtag);
                createBackupAndRotate();
                broadcastDatabaseInvalidated(req);
            }

            res.send({ success: true, etag });
        });
    });

}

module.exports = { installAssetRoutes };

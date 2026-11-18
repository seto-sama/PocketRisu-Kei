'use strict';

const { createDatabaseProjectionService, DatabaseProjectionServiceError } = require('../databaseProjectionService.cjs');
const { filterHiddenFolders, mergeHiddenFolders } = require('../privacyGuardFilter.cjs');
const { restoreGenerationOwnedMetadata } = require('../revenant/generationInputMetadata.cjs');
const { validateReferenceCandidates } = require('../../shared/contentReferences.mjs');
const { findChatInternalFieldOps } = require('../../shared/chatShape.mjs');
const { apiErrorMessage, codes } = require('../utils/apiErrors.cjs');
const { encode, decode } = require('msgpackr');
const { binaryBodyParser } = require('../utils/binaryHttp.cjs');
const { BINARY_MESSAGE_CONTENT_TYPE } = require('../../src/ts/network/binaryMessage.ts');

function installDatabaseRoutes(app, {
    appDataStore,
    checkAuth,
    queueStorageOperation,
    ensureCanonicalStorage,
    isPrivacyGuardActive,
    requireSyncClientId,
    syncTrashRetention,
    scheduleBackupAndRotate,
    broadcastDatabaseInvalidated,
    sessionAuthMiddleware,
}) {
    const databaseProjectionService = createDatabaseProjectionService({
        appDataStore,
        filterRemoteProjection: filterHiddenFolders,
        mergeRemoteProjection: mergeHiddenFolders,
        restoreServerOwnedMetadata: restoreGenerationOwnedMetadata,
    });

    const databaseRequestBody = [
        async (req, res, next) => {
            if (await checkAuth(req, res)) next();
        },
        binaryBodyParser('100mb'),
        (req, res, next) => {
            if (req.is(BINARY_MESSAGE_CONTENT_TYPE)) {
                try {
                    req.body = decode(req.body);
                } catch (error) {
                    return res.status(400).json({ error: error.message });
                }
            }
            next();
        },
    ];

    function sendDatabaseProjectionError(res, error) {
        if (!(error instanceof DatabaseProjectionServiceError)) return false;
        res.status(error.statusCode).json({
            error: error.message,
            code: error.code,
            ...(error.currentEtag ? { currentEtag: error.currentEtag } : {}),
            ...(Number.isSafeInteger(error.currentRevision)
                ? { currentRevision: error.currentRevision }
                : {}),
            ...(error.currentHash ? { currentHash: error.currentHash } : {}),
            ...(error.hashDiagnostics ? { hashDiagnostics: error.hashDiagnostics } : {}),
            ...(error.conflicts ? { conflicts: error.conflicts } : {}),
        });
        return true;
    }

    const PLUGIN_STORAGE_EXCLUSION_HEADER = 'x-risu-plugin-storage-exclusion';

    function pluginStorageProjectionOptions(req) {
        const raw = req.get(PLUGIN_STORAGE_EXCLUSION_HEADER);
        if (!raw) return {};
        if (raw === 'all') return { excludeAllPluginStorage: true };
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            const excludedPluginNames = Array.isArray(parsed.plugins)
                ? [...new Set(parsed.plugins.filter(name => typeof name === 'string'))]
                : [];
            return {
                excludedPluginNames,
                excludeUnclassifiedPluginStorage: parsed.unclassified === true,
            };
        } catch {
            throw new DatabaseProjectionServiceError('Invalid plugin storage exclusion header', {
                code: 'INVALID_PLUGIN_STORAGE_EXCLUSION',
                statusCode: 400,
            });
        }
    }

    app.post('/api/database/content-references', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        const { kind, candidates } = req.body ?? {};
        try { validateReferenceCandidates(kind, candidates); }
        catch (error) { return res.status(400).json({ error: error.message }); }
        const result = await queueStorageOperation(async () => {
            await ensureCanonicalStorage();
            return appDataStore.scanContentReferences(kind, candidates);
        });
        res.set('Cache-Control', 'no-store').json(result);
    });

    app.get('/api/database', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            await ensureCanonicalStorage();
            const projection = databaseProjectionService.getStartupProjection({
                remote: isPrivacyGuardActive(),
                ...pluginStorageProjectionOptions(req),
            });
            res.vary('Accept');
            if (req.accepts(['application/json', BINARY_MESSAGE_CONTENT_TYPE]) === BINARY_MESSAGE_CONTENT_TYPE) {
                res.type(BINARY_MESSAGE_CONTENT_TYPE).send(encode(projection));
            } else {
                res.json(projection);
            }
        } catch (error) {
            if (!sendDatabaseProjectionError(res, error)) next(error);
        }
    });

    app.put('/api/database', databaseRequestBody, async (req, res, next) => {
        if (!requireSyncClientId(req, res)) return;
        try {
            const result = await queueStorageOperation(async () => {
                await ensureCanonicalStorage();
                const initialized = databaseProjectionService.initializeDatabase(
                    req.body?.database,
                    {
                        expectedRevision: req.body?.expectedRevision,
                        remote: isPrivacyGuardActive(),
                    },
                );
                syncTrashRetention();
                scheduleBackupAndRotate();
                broadcastDatabaseInvalidated(req);
                return initialized;
            });
            res.json(result);
        } catch (error) {
            if (!sendDatabaseProjectionError(res, error)) next(error);
        }
    });

    app.patch('/api/database', databaseRequestBody, async (req, res, next) => {
        if (!requireSyncClientId(req, res)) return;
        try {
            const projectionOptions = {
                remote: isPrivacyGuardActive(),
                ...pluginStorageProjectionOptions(req),
            };
            const result = await queueStorageOperation(async () => {
                await ensureCanonicalStorage();
                const chatInternalOps = findChatInternalFieldOps(req.body?.patch);
                if (chatInternalOps.length > 0) {
                    const current = appDataStore.getState();
                    const error = new DatabaseProjectionServiceError(
                        apiErrorMessage(codes.CHAT_GUARD_REJECTED),
                        { code: codes.CHAT_GUARD_REJECTED, statusCode: 409 },
                    );
                    error.currentEtag = current.projectionEtag;
                    error.currentRevision = current.revision;
                    throw error;
                }
                const patched = databaseProjectionService.patchDatabase(req.body, {
                    ...projectionOptions,
                });
                syncTrashRetention();
                if (patched.changed) {
                    scheduleBackupAndRotate();
                    broadcastDatabaseInvalidated(req);
                }
                return patched;
            });
            res.json(result);
        } catch (error) {
            if (!sendDatabaseProjectionError(res, error)) next(error);
        }
    });

    app.post('/api/db/flush', sessionAuthMiddleware, async (req, res) => {
        if (!requireSyncClientId(req, res)) return;
        // Every database write runs on the storage queue, so draining it is
        // the whole flush.
        await queueStorageOperation(async () => {
            res.send({ success: true, etag: appDataStore.getState().projectionEtag });
        });
    });
}

module.exports = { installDatabaseRoutes };

'use strict';

const { createDatabaseProjectionService, DatabaseProjectionServiceError } = require('../databaseProjectionService.cjs');
const { filterRemoteOnlyFolders, mergeRemoteFilteredDatabase } = require('../remoteDatabaseFilter.cjs');
const { restoreGenerationOwnedMetadata } = require('../revenant/generationInputMetadata.cjs');
const { validateReferenceCandidates } = require('../../../shared/contentReferences.mjs');

function installDatabaseRoutes(app, {
    appDataStore,
    checkAuth,
    queueStorageOperation,
    ensureCanonicalStorage,
    isCloudflareTunnelRequest,
    requireSyncClientId,
    refreshCanonicalDatabaseCache,
    scheduleBackupAndRotate,
    broadcastDatabaseInvalidated,
    findChatInternalFieldOps,
    currentPersistWarning,
    sessionAuthMiddleware,
    flushPendingDb,
    storageState,
}) {
    const databaseProjectionService = createDatabaseProjectionService({
        appDataStore,
        filterRemoteOnlyFolders,
        mergeRemoteFilteredDatabase,
        restoreGenerationOwnedMetadata,
    });

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

    app.post('/api/database/content-references', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        const { kind, candidates } = req.body ?? {};
        try { validateReferenceCandidates(kind, candidates); }
        catch (error) { return res.status(400).json({ error: error.message }); }
        try {
            const result = await queueStorageOperation(async () => {
                await ensureCanonicalStorage();
                return appDataStore.scanContentReferences(kind, candidates);
            });
            res.set('Cache-Control', 'no-store').json(result);
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/database', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            await ensureCanonicalStorage();
            res.json(databaseProjectionService.getStartupProjection({
                remote: isCloudflareTunnelRequest(req),
                ...pluginStorageProjectionOptions(req),
            }));
        } catch (error) {
            if (!sendDatabaseProjectionError(res, error)) next(error);
        }
    });

    app.put('/api/database', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const result = await queueStorageOperation(async () => {
                await ensureCanonicalStorage();
                const initialized = databaseProjectionService.initializeDatabase(
                    req.body?.database,
                    {
                        expectedRevision: req.body?.expectedRevision,
                        remote: isCloudflareTunnelRequest(req),
                    },
                );
                refreshCanonicalDatabaseCache({ invalidateChats: true });
                scheduleBackupAndRotate();
                broadcastDatabaseInvalidated(req);
                return initialized;
            });
            res.json(result);
        } catch (error) {
            if (!sendDatabaseProjectionError(res, error)) next(error);
        }
    });

    app.patch('/api/database', async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const projectionOptions = {
                remote: isCloudflareTunnelRequest(req),
                ...pluginStorageProjectionOptions(req),
            };
            const result = await queueStorageOperation(async () => {
                await ensureCanonicalStorage();
                const chatInternalOps = findChatInternalFieldOps(req.body?.patch);
                if (chatInternalOps.length > 0) {
                    const current = databaseProjectionService.getStartupProjection({
                        ...projectionOptions,
                    });
                    const error = new DatabaseProjectionServiceError(
                        'Patch rejected: chat-internal field ops not allowed for lazy-loaded chats',
                        { code: 'CHAT_GUARD_REJECTED', statusCode: 409 },
                    );
                    error.currentEtag = current.etag;
                    error.currentRevision = current.revision;
                    error.chatGuardRejected = true;
                    throw error;
                }
                const patched = databaseProjectionService.patchDatabase(req.body, {
                    ...projectionOptions,
                });
                refreshCanonicalDatabaseCache();
                if (patched.changed) {
                    scheduleBackupAndRotate();
                    broadcastDatabaseInvalidated(req);
                }
                const persistWarning = currentPersistWarning();
                return persistWarning ? { ...patched, persistWarning } : patched;
            });
            res.json(result);
        } catch (error) {
            if (error?.code === 'CHAT_GUARD_REJECTED') {
                return res.status(409).json({
                    error: error.message,
                    code: error.code,
                    chatGuardRejected: true,
                    currentEtag: error.currentEtag,
                    currentRevision: error.currentRevision,
                });
            }
            if (!sendDatabaseProjectionError(res, error)) next(error);
        }
    });

    app.post('/api/db/flush', sessionAuthMiddleware, async (req, res, next) => {
        if (!requireSyncClientId(req, res)) return;
        try {
            await queueStorageOperation(async () => {
                await flushPendingDb();
                res.send({
                    success: true,
                    etag: storageState.dbEtag ?? undefined
                });
            });
        } catch (error) {
            next(error);
        }
    });
}

module.exports = { installDatabaseRoutes };

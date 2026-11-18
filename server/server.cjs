const express = require('express');

const app = express();
const isDevelopment = process.argv.includes('--dev');
let viteDevServer = null;
const http = require('http');
const https = require('https');
const path = require('path');
const compression = require('compression');
const { migrateCertificates } = require('./ssl/migrateCertificates.cjs');
const { codes: API_ERROR_CODES, normalizeApiError } = require('./utils/apiErrors.cjs');
const { createInlayService, installInlaysRoutes } = require('./inlay.cjs');
const { createAuthService } = require('./auth.cjs');
const { createSnapshotService } = require('./snapshots.cjs');
const { createBackupLocation } = require('./backupLocation.cjs');
const { createCanonicalStorage } = require('./canonicalStorage.cjs');
const { createSyncHub, getSyncClientIdFromRequest, requireSyncClientId } = require('./syncHub.cjs');
const { getMimeFromExt } = require('./utils/mime.cjs');

const { existsSync, mkdirSync } = require('fs');
const fs = require('fs/promises')
const nodeCrypto = require('crypto')

const { WebSocketServer } = require('ws')
const Vips = require('wasm-vips')
let _vipsPromise = null
const getVips = () => {
    if (!_vipsPromise) {
        _vipsPromise = Vips().catch(err => {
            _vipsPromise = null
            throw err
        })
    }
    return _vipsPromise
}
const { kvGet, kvSet, kvSetChunked, kvDel, kvList, checkpointWal, chunkStore, db: sqliteDb } = require('./db.cjs');
const { createAppDataStore } = require('./appDataStore.cjs');
const appDataStore = createAppDataStore(sqliteDb);
const { createConfiguredLocalUrlProvider } = require('./configuredNetworkTargets.cjs');
const outboundPolicy = require('./outboundPolicy.cjs').createOutboundPolicy({
    getAllowedLocalUrls: createConfiguredLocalUrlProvider(appDataStore),
});

const { createBookmarkStore } = require('./bookmarkStore.cjs');
const bookmarkStore = createBookmarkStore(sqliteDb);

const { logger, installProcessHandlers, expressErrorMiddleware } = require('./logs/logs.cjs');
const { REVENANT_CAPACITY } = require('./revenant/capacity.cjs');

const {
    generationDb,
    finishGenerationWorkflow,
    getGenerationWorkflow,
    cancelGenerationWorkflow,
    cancelGenerationStepExecution,
    pruneRetainedGenerationJobs,
    checkpointGenerationDb,
    installRevenantGenerationRoutes,
    installImageGenerationJobRoutes,
    createImageGenerationJobService,
    createGenerationWorkers,
    createRevenantMaterializer,
    createRevenantPostprocessWorker,
    createGenerationWorkflowService,
} = require('./revenant/index.cjs');
const {
    createProviderJobRunner,
    normalizeForwardHeaders,
    sanitizeGenerationTargetUrl,
} = require('./revenant/providerJobRunner.cjs');
const { createServerImageActions } = require('./revenant/serverImageAction.cjs');
const { createCanonicalChatService } = require('./chatStore.cjs');
const { createPrivacyGuard } = require('./privacyGuard.cjs');

const { encodeRisuSaveLegacy } = require('./utils/risuSave.cjs');

installProcessHandlers();

const MISSING_DATABASE_ETAG = '__missing_database__';
let driveRoutes;

function computeBufferEtag(buffer) {
    return nodeCrypto.createHash('md5').update(buffer).digest('hex');
}

function computeDatabaseEtagFromObject(databaseObject) {
    return computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(databaseObject)));
}

let storageOperationQueue = Promise.resolve();
function queueStorageOperation(operation) {
    const operationRun = storageOperationQueue.then(operation, operation);
    storageOperationQueue = operationRun.catch(() => {});
    return operationRun;
}

const snapshots = createSnapshotService({
    sqliteDb,
    chunkStore,
    kvGet,
    kvSetChunked,
    kvDel,
    appDataStore,
    bookmarkStore,
    logger,
});
const { DB_BACKUP_PREFIX, createBackupAndRotate, scheduleBackupAndRotate } = snapshots;

const canonicalStorage = createCanonicalStorage({
    sqliteDb,
    kvGet,
    kvSet,
    kvSetChunked,
    kvDel,
    checkpointWal,
    appDataStore,
    bookmarkStore,
    logger,
    scheduleBackupAndRotate,
    // Drive routes are installed later; trash cleanup re-arms once they exist.
    refreshTrashRetention: () => driveRoutes?.refreshTrashRetention?.(),
});
const {
    normalizeColdStorageStorageKey,
    normalizeColdStorageBackupBuffer,
    listColdStorageBackupEntries,
    normalizeLegacyDatabaseProjection,
    readTrashRetentionDays,
    syncTrashRetention,
    ensureCanonicalStorage,
    prepareDatabaseExport,
    loadCanonicalChat,
    persistCanonicalChat,
} = canonicalStorage;

function shouldCompress(req, res) {
    const url = req.originalUrl || req.url;
    if (res.locals.skipCompression || url.startsWith('/api/backup/export') || url.startsWith('/api/backup/server/download/')) {
        return false;
    }

    const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
        return false;
    }
    // NDJSON progress streams must flush each line so keepalives reach reverse
    // proxies before they time out; gzip would buffer them.
    if (contentType.includes('application/x-ndjson')) {
        return false;
    }
    // Already-compressed media formats: gzip adds CPU cost with ~0% size gain
    if (contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/')) {
        return false;
    }
    if (contentType.includes('application/octet-stream')) {
        return true;
    }
    return compression.filter(req, res);
}

app.use(compression({
    filter: shouldCompress,
}));
if (!isDevelopment) {
    // Vite 산출물은 해시 파일명이므로 /assets는 장기 캐시 안전
    app.use('/assets', express.static(path.join(process.cwd(), 'dist/assets'), {
        maxAge: '1y',
        immutable: true,
    }));
    app.use(express.static(path.join(process.cwd(), 'dist'), {index: false, maxAge: 0}));
}

const savePath = path.join(process.cwd(), "save")
if(!existsSync(savePath)){
    mkdirSync(savePath)
}

const auth = createAuthService({ savePath });
const { checkAuth, checkDownloadAuth, sessionAuthMiddleware } = auth;
const privacyGuard = createPrivacyGuard({ savePath });
const isPrivacyGuardActive = () => privacyGuard.isEnabled();

const backupLocation = createBackupLocation({ kvGet });
const { backupState, DEFAULT_BACKUPS_DIR, BACKUP_FILENAME_REGEX } = backupLocation;

const tunnelState = {
    tunnelProcess: null,
    tunnelUrl: null,
    tunnelStatus: 'off', // 'off' | 'downloading' | 'starting' | 'running' | 'error'
    tunnelError: null,
    tunnelStartTimeout: null,
    serverIsHttps: false,
};

function stopTunnel() {
    if (tunnelState.tunnelStartTimeout) { clearTimeout(tunnelState.tunnelStartTimeout); tunnelState.tunnelStartTimeout = null; }
    if (tunnelState.tunnelProcess) {
        try { tunnelState.tunnelProcess.kill('SIGTERM'); } catch {}
        tunnelState.tunnelProcess = null;
    }
    tunnelState.tunnelUrl = null;
    tunnelState.tunnelStatus = 'off';
    tunnelState.tunnelError = null;
}

const inlayService = createInlayService({
    inlayDir: path.join(savePath, 'inlays'),
    getVips,
    getMimeFromExt,
    kvGet,
    kvDel,
    kvList,
    logger,
});
const {
    inlayDir,
    inlayMigrationMarker,
    isSafeInlayId,
    normalizeInlayExt,
    ensureInlayDir,
    getInlaySidecarPath,
    readInlayFile,
    listInlayFiles,
    writeInlayFile,
    migrateInlaysToFilesystem,
    sumInlayFsBytes,
    decodeDataUri,
} = inlayService;

const syncHub = createSyncHub();
const {
    syncClientDevices,
    isSyncClientConnected,
    broadcastDatabaseInvalidated,
    broadcastBookmarksInvalidated,
    broadcastPrivacyGuardChanged,
    publishChatCommitted,
    broadcastRevenantWorkflowUpdated,
} = syncHub;

const providerJobs = createProviderJobRunner({
    repository: generationDb,
    outboundPolicy,
    scheduleHypaWorkflowExecution: () => scheduleHypaWorkflowExecution(),
    scheduleRevenantPostprocess: () => scheduleRevenantPostprocess(),
});
const {
    generationRuntimeJobs,
    createGenerationRuntimeJob,
    markGenerationJobDone,
    runGenerationProviderJob,
} = providerJobs;
let imageGenerationJobService;

function countActiveProviderJobs() {
    return (imageGenerationJobService?.countActiveJobs() ?? 0) + providerJobs.countActiveJobs();
}

const generationWorkers = createGenerationWorkers({
    repository: generationDb,
    logger,
    generationRuntimeJobs,
    capacity: REVENANT_CAPACITY,
    countActiveProviderJobs,
    createGenerationRuntimeJob,
    runGenerationProviderJob,
    markGenerationJobDone,
    sanitizeGenerationTargetUrl,
    executeSummaryAction: input => executeServerProviderAction(input),
});
const {
    abortHypaWorkflowExecution,
    scheduleGenerationDispatch,
    scheduleHypaWorkflowExecution,
} = generationWorkers;

const canonicalChatService = createCanonicalChatService({
    queueStorageOperation,
    loadChat: loadCanonicalChat,
    getGenerationWorkflowInputChat: generationDb.getGenerationWorkflowInputChat,
    persistChat: persistCanonicalChat,
    publishChatCommitted,
});
imageGenerationJobService = createImageGenerationJobService({
    logger,
    capacity: REVENANT_CAPACITY,
    countActiveProviderJobs,
});

const {
    executeServerImageAction,
    scheduleImageGenerationWorkflow,
} = createServerImageActions({
    repository: generationDb,
    appDataStore,
    canonicalChatService,
    imageGenerationJobService,
    inlayService,
    getVips,
    kvGet,
    kvSet,
    onWorkflowUpdated: broadcastRevenantWorkflowUpdated,
});
const revenantMaterializer = createRevenantMaterializer({
    repository: generationDb,
    canonicalChatService,
});
const generationWorkflowService = createGenerationWorkflowService({
    finishGenerationWorkflow,
    cancelGenerationWorkflow,
    cancelGenerationStepExecution,
    generationRuntimeJobs,
    markGenerationJobDone,
    abortHypaWorkflowExecution,
    abortWorkflowWork: imageGenerationJobService.abortWorkflow,
    commitWorkflowInput: commitRevenantWorkflowInput,
    updateGenerationWorkflowStep: generationDb.updateGenerationWorkflowStep,
    getGenerationWorkflow,
    materializeCancelledWorkflow: revenantMaterializer.materializeCancellation,
    publishCanonicalWorkflowChat: workflowId => {
        const workflow = getGenerationWorkflow(workflowId);
        if (!workflow) return false;
        return canonicalChatService.publishCurrent(
            workflow.characterId,
            workflow.roomId,
            'workflow-failed',
        );
    },
});
const executeServerProviderAction = require('./revenant/providerActions.cjs').createServerProviderActionExecutor({
    repository: generationDb,
    scheduleGenerationDispatch,
    sanitizeGenerationTargetUrl,
    getDatabase: () => appDataStore.exportProjection({ includeMessages: false }),
    readInlay: async id => {
        const file = await readInlayFile(id);
        if (!file) return {};
        return {
            type: file.mime.split('/')[0],
            base64: `data:${file.mime};base64,${file.buffer.toString('base64')}`,
        };
    },
    writeMedia: async media => {
        const id = nodeCrypto.randomUUID();
        const ext = media.mime.split('/')[1]?.split(';')[0] || (media.kind === 'image' ? 'png' : 'mp3');
        await writeInlayFile(id, ext, Buffer.from(media.base64, 'base64'), {
            name: `generated-${media.kind}.${ext}`, type: media.kind, ext,
        });
        return `{{inlayeddata::${id}}}`;
    },
    cancelJob: require('./revenant/generationWorkflowService.cjs')
        .createGenerationJobCancellationService({
            repository: generationDb,
            generationRuntimeJobs,
            isJobActive: status => ['queued', 'generating'].includes(status),
        }).cancel,
});
const revenantPostprocessWorker = createRevenantPostprocessWorker({
    repository: generationDb,
    logger,
    materializeGeneration: revenantMaterializer.materialize,
    onWorkflowUpdated: broadcastRevenantWorkflowUpdated,
    executeImageAction: executeServerImageAction,
    executeProviderAction: executeServerProviderAction,
});
const scheduleRevenantPostprocess = revenantPostprocessWorker.schedule;

// WebSocket clients may pass the token as a query parameter because browsers
// cannot set custom headers on the upgrade request.
function isAuthorizedUpgrade(req, reqUrl) {
    const header = Array.isArray(req.headers['risu-auth'])
        ? req.headers['risu-auth'][0]
        : req.headers['risu-auth'];
    const auth = reqUrl.searchParams.get('risu-auth') || (typeof header === 'string' ? header : '');
    return checkAuth({ headers: { 'risu-auth': auth } }, null, true);
}

function setupGenerationWebSocket(server) {
    const wsServer = new WebSocketServer({ noServer: true });
    const syncWsServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', async (req, socket, head) => {
        try {
            if (viteDevServer && ['vite-hmr', 'vite-ping'].includes(req.headers['sec-websocket-protocol'])) return;
            const reqUrl = new URL(req.url, `http://${req.headers.host}`);
            if (reqUrl.pathname === '/sync') {
                const clientId = reqUrl.searchParams.get('client-id');
                if (!clientId || !await isAuthorizedUpgrade(req, reqUrl)) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                syncWsServer.handleUpgrade(req, socket, head, (ws) => {
                    syncWsServer.emit('connection', ws, req, clientId);
                });
                return;
            }
            const generationJournalMatch = reqUrl.pathname.match(
                /^\/api\/generation\/jobs\/([^/]+)\/journal\/ws$/,
            );
            if (!generationJournalMatch) {
                socket.destroy();
                return;
            }

            if (!await isAuthorizedUpgrade(req, reqUrl)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            const jobId = decodeURIComponent(generationJournalMatch[1]);
            if (!providerJobs.findJob(jobId)) {
                socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                socket.destroy();
                return;
            }

            wsServer.handleUpgrade(req, socket, head, (ws) => {
                wsServer.emit('connection', ws, req, jobId);
            });
        } catch {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
        }
    });

    syncWsServer.on('connection', syncHub.handleSyncConnection);

    wsServer.on('connection', providerJobs.handleJournalConnection);
}

async function commitRevenantWorkflowInput({ characterId, roomId, input }) {
    return canonicalChatService.commitGenerationInput({
        characterId,
        chatId: roomId,
        changes: input.changes,
    });
}

require('./routes/auth.cjs').installAuthRoutes(app, {
    auth,
    syncClientDevices,
    privacyGuard,
    broadcastPrivacyGuardChanged,
});

require('./requestBody.cjs').installAuthenticatedBodyParsing(app, {
    checkAuth: checkDownloadAuth,
});

installImageGenerationJobRoutes(app, {
    checkProxyAuth: checkAuth, requireSyncClientId, service: imageGenerationJobService,
});

require('./routes/imageTags.cjs').installImageTagRoutes(app, {
    checkAuth,
    cacheDir: path.join(savePath, 'cache', 'image-tags'),
});

installRevenantGenerationRoutes(app, {
    checkProxyAuth: checkAuth,
    requireSyncClientId,
    isSyncClientConnected,
    sanitizeGenerationTargetUrl,
    normalizeForwardHeaders,
    createGenerationRuntimeJob,
    runGenerationProviderJob,
    scheduleGenerationDispatch,
    scheduleHypaWorkflowExecution,
    scheduleRevenantPostprocess,
    scheduleImageGenerationWorkflow,
    notifyRevenantWorkflowUpdated: broadcastRevenantWorkflowUpdated,
    terminateGenerationWorkflow: generationWorkflowService.terminateWorkflow,
    commitWorkflowInput: generationWorkflowService.commitInput,
    cancelGenerationStepExecution: generationWorkflowService.cancelStepExecution,
    generationRuntimeJobs,
    countActiveProviderJobs,
    capacity: REVENANT_CAPACITY,
    randomUUID: () => nodeCrypto.randomUUID(),
});

require('./routes/web.cjs').installWebRoutes(app, {
    isPrivacyGuardActive,
    getDevServer: () => viteDevServer,
});

require('./routes/proxy.cjs').installProxyRoutes(app, {
    checkAuth,
    outboundPolicy,
});

require('./routes/fileFormats.cjs').installFileFormatRoutes(app, {
    checkAuth,
});

require('./routes/assets/index.cjs').installAssetRoutes(app, {
    queueStorageOperation,
    bookmarkStore,
    appDataStore,
    inlayService,
    sessionAuthMiddleware,
    checkAuth,
    ensureCanonicalStorage,
    MISSING_DATABASE_ETAG,
    isPrivacyGuardActive,
    computeBufferEtag,
    requireSyncClientId,
    computeDatabaseEtagFromObject,
    normalizeLegacyDatabaseProjection,
    syncTrashRetention,
    createBackupAndRotate,
    broadcastDatabaseInvalidated,
});

require('./routes/pluginStorage.cjs').installPluginStorageRoutes(app, {
    appDataStore, checkAuth, requireSyncClientId, queueStorageOperation, ensureCanonicalStorage,
});

require('./routes/database.cjs').installDatabaseRoutes(app, {
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
});

require('./routes/logs.cjs').installLogsRoutes(app, {
    checkAuth,
    requireSyncClientId,
});

require('./routes/backup.cjs').installBackupRoutes(app, {
    snapshots,
    backupLocation,
    checkDownloadAuth,
    normalizeLegacyDatabaseProjection,
    bookmarkStore,
    appDataStore,
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
    checkAuth,
    listInlayFiles,
    getInlaySidecarPath,
    listColdStorageBackupEntries,
    requireSyncClientId,
    queueStorageOperation,
    broadcastDatabaseInvalidated,
    broadcastBookmarksInvalidated,
    syncTrashRetention,
});

require('./routes/bookmarks.cjs').installBookmarksRoutes(app, {
    isPrivacyGuardActive,
    ensureCanonicalStorage,
    appDataStore,
    checkAuth,
    bookmarkStore,
    requireSyncClientId,
    loadCanonicalChat,
    broadcastBookmarksInvalidated,
});

require('./routes/chats.cjs').installChatsRoutes(app, {
    checkAuth,
    ensureCanonicalStorage,
    isPrivacyGuardActive,
    appDataStore,
    loadCanonicalChat,
    requireSyncClientId,
    canonicalChatService,
    getSyncClientIdFromRequest,
    bookmarkStore,
    broadcastBookmarksInvalidated,
});

require('./routes/maintenance.cjs').installMaintenanceRoutes(app, {
    checkAuth,
    ensureCanonicalStorage,
    backupState,
    DEFAULT_BACKUPS_DIR,
    sumInlayFsBytes,
    listColdStorageBackupEntries,
    appDataStore,
    DB_BACKUP_PREFIX,
    BACKUP_FILENAME_REGEX,
    requireSyncClientId,
    queueStorageOperation,
});

installInlaysRoutes(app, {
    sessionAuthMiddleware,
    requireSyncClientId,
    inlayService,
});

require('./routes/system.cjs').installSystemRoutes(app);

require('./routes/tunnel.cjs').installTunnelRoutes(app, {
    checkAuth,
    tunnelState,
    stopTunnel,
});

driveRoutes = require('./routes/drive.cjs').installDriveRoutes(app, {
    savePath,
    checkAuth,
    checkDownloadAuth,
    isPrivacyGuardActive,
    encodeThumbnail: inlayService.encodeThumbnail,
    getTrashRetentionDays: async () => {
        await ensureCanonicalStorage();
        return readTrashRetentionDays();
    },
});

if (isDevelopment) {
    app.use((req, res, next) => viteDevServer.middlewares(req, res, next));
}

// Error middleware must be registered after all routes.
app.use(expressErrorMiddleware);
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    err = normalizeApiError(err);
    const unsupportedRemote = err?.code === API_ERROR_CODES.UNSUPPORTED_REMOTE_SAVE;
    const requestedStatus = err?.statusCode ?? err?.httpStatus;
    const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
        ? requestedStatus
        : unsupportedRemote ? 400 : 500;
    res.status(status).json({
        error: err?.message || 'internal server error',
        ...(err?.code ? { code: err.code } : {}),
        ...(err?.details ? { details: err.details } : {}),
    });
});

async function getHttpsOptions() {
    const sslPath = await migrateCertificates(process.cwd());
    const keyPath = path.join(sslPath, 'server.key');
    const certPath = path.join(sslPath, 'server.crt');

    try {
 
        await fs.access(keyPath);
        await fs.access(certPath);

        const [key, cert] = await Promise.all([
            fs.readFile(keyPath),
            fs.readFile(certPath)
        ]);
       
        return { key, cert };

    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('[Server] No SSL certificate found, starting with HTTP');
        } else {
            logger.error('[Server] SSL setup errors:', error.message);
            console.log('[Server] Start the server with HTTP instead of HTTPS...');
        }
        return null;
    }
}

async function startServer() {
    try {
        await migrateInlaysToFilesystem();
        const port = process.env.PORT || 6001;
        const httpsOptions = await getHttpsOptions();
        const protocol = httpsOptions ? 'https' : 'http';
        const server = httpsOptions ? https.createServer(httpsOptions, app) : http.createServer(app);
        tunnelState.serverIsHttps = Boolean(httpsOptions);
        if (isDevelopment) {
            const { createServer: createViteServer } = await import('vite');
            viteDevServer = await createViteServer({
                root: path.join(__dirname, '..'),
                appType: 'custom',
                server: { middlewareMode: true, ws: { server } },
            });
            console.log('[Server] Vite development mode enabled.');
        }
        setupGenerationWebSocket(server);
        server.listen(port, () => {
            console.log(`[Server] ${protocol.toUpperCase()} server is running.`);
            console.log(`[Server] ${protocol}://localhost:${port}/`);
        });
    } catch (error) {
        logger.error('[Server] Failed to start server :', error);
        process.exit(1);
    }
}

for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
        console.log(`[Server] Received ${sig}, flushing pending data...`);
        await viteDevServer?.close();
        stopTunnel();
        await driveRoutes.stopTrashCleanup();
        const generationRuns = providerJobs.abortAll();
        imageGenerationJobService.abortAll();
        const imageGenerationRuns = [...imageGenerationJobService.jobs.values()]
            .map(job => job.runPromise)
            .filter(Boolean);
        if (generationRuns.length > 0) await Promise.allSettled(generationRuns);
        if (imageGenerationRuns.length > 0) await Promise.allSettled(imageGenerationRuns);
        try { checkpointWal('TRUNCATE'); } catch { /* non-fatal */ }
        try { checkpointGenerationDb('TRUNCATE'); } catch { /* non-fatal */ }
        process.exit(0);
    });
}

(async () => {
    try {
        await ensureCanonicalStorage();
    } catch (error) {
        logger.error('[AppData] Failed to initialize canonical relational storage:', error);
        process.exitCode = 1;
        return;
    }
    try { await providerJobs.rebuildMissingGenerationProjections(); }
    catch (error) { logger.error('[GenerationJob] Initial projection rebuild failed:', error); }
    try { pruneRetainedGenerationJobs(); }
    catch (error) { logger.error('[GenerationJob] Initial retention cleanup failed:', error); }
    scheduleGenerationDispatch();
    scheduleHypaWorkflowExecution();
    scheduleRevenantPostprocess();

    providerJobs.startGarbageCollection();

    await startServer();

    // TRUNCATE (vs RESTART) shrinks the -wal file on disk, not just the writer
    // pointer — required for journal_size_limit to actually take effect.
    setInterval(() => {
        try { checkpointWal('TRUNCATE'); }
        catch { /* non-fatal */ }
        try { checkpointGenerationDb('PASSIVE'); }
        catch { /* non-fatal */ }
    }, 5 * 60 * 1000);

    setInterval(() => {
        try { pruneRetainedGenerationJobs(); }
        catch (error) { logger.error('[GenerationJob] Retention cleanup failed:', error); }
    }, 60 * 60 * 1000);

})();

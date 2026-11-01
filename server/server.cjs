const express = require('express');

const app = express();
const isDevelopment = process.argv.includes('--dev');
let viteDevServer = null;
const http = require('http');
const https = require('https');
const path = require('path');
const compression = require('compression');
const { migrateCertificates } = require('./ssl/migrateCertificates.cjs');
const { codes: API_ERROR_CODES, createApiError } = require('./utils/apiErrors.cjs');
const { createInlayService, installInlaysRoutes } = require('./inlay.cjs');
const { createAuthService } = require('./auth.cjs');
const { createSnapshotService } = require('./snapshots.cjs');
const { createBackupLocation } = require('./backupLocation.cjs');
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
const { removeRuntimeCharacterFields } = require('./persistenceShape.cjs');
const {
    AppDataMigrationCleanupError,
    createAppDataMigration,
    migratePromptPresetSelection,
} = require('./appDataMigration.cjs');
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
    applyMutationPatch,
} = require('./revenant/index.cjs');
const {
    createProviderJobRunner,
    normalizeForwardHeaders,
    sanitizeGenerationTargetUrl,
} = require('./revenant/providerJobRunner.cjs');
const { createServerImageActions } = require('./revenant/serverImageAction.cjs');
const { createCanonicalChatService } = require('./chatStore.cjs');
const { applyGenerationInputMetadata } = require('./revenant/generationInputMetadata.cjs');
const { isCloudflareTunnelRequest: isCloudflareTunnelRequestForUrl } = require('./remoteDatabaseFilter.cjs');
const { normalizeTrashRetentionDays } = require('../shared/trashRetention.mjs');

const { decodeRisuSave, encodeRisuSaveLegacy } = require('./utils/risuSave.cjs');
const { normalizeJSON } = require('./utils/json.cjs');
const { importPromptPresetSelection } = require('../shared/promptPresetSelection.mjs');
const { createLegacyRestoreService } = require('./dataRestore/index.cjs');

installProcessHandlers();

const {
    normalizeColdStorageStorageKey,
    normalizeColdStorageBackupBuffer,
    listColdStorageBackupEntries,
    restoreColdStorageInDb,
    restoreColdStorageChat,
} = createLegacyRestoreService({
    sqliteDb,
    kvGet,
    kvSet,
    kvDel,
    logger,
});

const appDataMigration = createAppDataMigration({
    db: sqliteDb,
    appDataStore,
    kv: {
        get: kvGet,
        delete: kvDel,
    },
    decodeLegacyBlob: async raw => {
        const decoded = await decodeRisuSave(raw);
        const { database } = normalizeLegacyDatabaseProjection(decoded);
        // Relational rows omit chatPage and runtime fields; verify against that shape.
        for (const char of database.characters ?? []) removeRuntimeCharacterFields(char);
        return database;
    },
    normalizeProjection: normalizeJSON,
});

const MISSING_DATABASE_ETAG = '__missing_database__';
let appDataReadyPromise = null;
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

async function prepareDatabaseExport() {
    await ensureCanonicalStorage();

    const [checkpoint] = checkpointWal('FULL') ?? [];
    if (!checkpoint
        || checkpoint.busy > 0
        || checkpoint.log !== checkpoint.checkpointed) {
        throw createApiError(API_ERROR_CODES.DATABASE_LOCKED, 503, checkpoint && {
            busy: checkpoint.busy,
            log: checkpoint.log,
            checkpointed: checkpoint.checkpointed,
        });
    }
}

function assignMissingPersistentIds(dbObj) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    const characterIds = new Set();
    for (const char of dbObj.characters) {
        if (!char) continue;
        if (!char.chaId || characterIds.has(char.chaId)) {
            char.chaId = nodeCrypto.randomUUID();
            changed = true;
        }
        characterIds.add(char.chaId);
        if (!char?.chats) continue;
        const chatIds = new Set();
        for (const chat of char.chats) {
            // A metadata-only legacy entry names a body stored elsewhere;
            // renaming it here would orphan that body.
            if (!Array.isArray(chat?.message)) continue;
            if (!chat.id || chatIds.has(chat.id)) {
                chat.id = nodeCrypto.randomUUID();
                changed = true;
            }
            chatIds.add(chat.id);
            const messageIds = new Set();
            for (const message of chat.message) {
                if (!message) continue;
                if (typeof message.chatId !== 'string' || !message.chatId || messageIds.has(message.chatId)) {
                    message.chatId = nodeCrypto.randomUUID();
                    changed = true;
                }
                messageIds.add(message.chatId);
            }
        }
    }
    return changed;
}

// Older saves can keep a folderId for a deleted folder, which hides the chat
// from every sidebar section; clear it so those chats show up again.
function normalizeOrphanFolderIds(dbObj) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        const validIds = new Set((char.chatFolders ?? []).map(f => f?.id).filter(Boolean));
        for (const chat of char.chats) {
            if (!chat) continue;
            if (chat.folderId && !validIds.has(chat.folderId)) {
                chat.folderId = null;
                changed = true;
            }
        }
    }
    return changed;
}

function normalizeLegacyDatabaseProjection(dbObj, options) {
    const normalized = normalizeJSON(dbObj);
    importPromptPresetSelection(normalized);
    assignMissingPersistentIds(normalized);
    normalizeOrphanFolderIds(normalized);

    const coldRestoreResult = restoreColdStorageInDb(normalized, options);
    return { database: normalized, coldRestoreResult };
}

function isCloudflareTunnelRequest(req) {
    return isCloudflareTunnelRequestForUrl(req, tunnelState.tunnelUrl);
}

/**
 * Read a canonical chat as a caller-owned { chat, etag }. Legacy rows that
 * still hold a cold-storage stub are normalized once and
 * committed under the row's content ETag. `coldRestoreFailed` reports a
 * cold-storage body that could not be read; the chat is returned as stored.
 */
async function loadCanonicalChat(characterId, chatId) {
    await ensureCanonicalStorage();
    if (!appDataStore.getState().initialized || !characterId || !chatId) return undefined;
    const state = appDataStore.getChatState(characterId, chatId);
    if (!state) return undefined;
    const { chat } = state;
    const storedMessages = chat.message;
    let coldRestoreFailed;
    try {
        coldRestoreFailed = !restoreColdStorageChat(chat);
    } catch (error) {
        logger.error(`[ColdStorage] restore failed for ${characterId}/${chatId}:`, error);
        coldRestoreFailed = true;
    }
    const restored = chat.message !== storedMessages;
    if (!restored) return { ...state, coldRestoreFailed };
    assignMissingPersistentIds({ characters: [{ chaId: characterId, chats: [chat] }] });
    const committed = appDataStore.commitChat(characterId, chatId, chat, state.etag);
    return { chat: committed.chat, etag: committed.etag, coldRestoreFailed };
}

/**
 * Commit a canonical chat body. Generation input and results also update
 * server-owned activity metadata in the same transaction, read from the store
 * itself, so concurrent devices increment the server value instead of racing
 * client-side snapshots.
 */
async function persistCanonicalChat({
    characterId,
    chatId,
    chat,
    expectedEtag,
    generationInput = false,
    mutationPatch,
}) {
    await ensureCanonicalStorage();
    if (!appDataStore.getState().initialized) {
        throw new Error('Canonical relational database is missing');
    }
    let committed;
    let metadata;
    sqliteDb.transaction(() => {
        committed = appDataStore.commitChat(characterId, chatId, chat, expectedEtag);
        if (!generationInput && !mutationPatch) return;
        const nextDb = appDataStore.exportProjection({ includeMessages: false });
        if (generationInput) {
            metadata = applyGenerationInputMetadata(nextDb, characterId);
            if (!metadata) {
                const error = new Error('Generation input character not found');
                error.httpStatus = 404;
                throw error;
            }
        }
        if (mutationPatch) applyMutationPatch(nextDb, characterId, mutationPatch);
        appDataStore.syncStartupProjection(nextDb);
    })();
    try {
        scheduleBackupAndRotate();
    } catch (error) {
        logger.warn('[CanonicalChat] Backup rotation failed:', error);
    }
    return { ...committed, metadata };
}

function shouldCompress(req, res) {
    // Keep proxied responses and streaming downloads uncompressed.
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

const backupLocation = createBackupLocation({ savePath, kvGet });
const { backupState, DEFAULT_BACKUPS_DIR, BACKUP_FILENAME_REGEX } = backupLocation;

// ── Cloudflare Quick Tunnel ─────────────────────────────────────────────────

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


// --- WebSocket setup ---

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

// Drive trash expiry follows the stored setting; re-arm it when a database
// write changes the value.
let trashRetentionDays = normalizeTrashRetentionDays(undefined);

function readTrashRetentionDays() {
    return appDataStore.getState().initialized
        ? appDataStore.getRootValue('trashRetentionDays')
        : undefined;
}

function syncTrashRetention() {
    const next = normalizeTrashRetentionDays(readTrashRetentionDays());
    if (next === trashRetentionDays) return;
    trashRetentionDays = next;
    const refresh = driveRoutes?.refreshTrashRetention;
    if (refresh) {
        void refresh().catch(error => {
            logger.warn('[Drive] Failed to refresh trash retention:', error);
        });
    }
}

async function ensureCanonicalStorage() {
    if (appDataReadyPromise) return appDataReadyPromise;
    appDataReadyPromise = (async () => {
        // Preserve the exact pre-cutover bytes as a downgrade/recovery escape
        // hatch; the live blob is deleted after relational install verifies.
        const originalLegacyBlob = kvGet('database/database.bin');
        if (originalLegacyBlob
            && !appDataStore.getState().initialized
            && !appDataMigration.getMarker()) {
            const sourceHash = nodeCrypto.createHash('sha256')
                .update(originalLegacyBlob)
                .digest('hex');
            const backupKey = `migration-backup/pre-relational-${sourceHash.slice(0, 16)}.bin`;
            if (!kvGet(backupKey)) {
                kvSetChunked(backupKey, Buffer.from(originalLegacyBlob));
            }
        }
        try {
            await appDataMigration.run();
        } catch (error) {
            if (!(error instanceof AppDataMigrationCleanupError)
                || !appDataStore.getState().initialized) {
                throw error;
            }
            logger.warn('[AppData] Canonical rows installed; legacy blob cleanup will retry:', error);
        }

        migratePromptPresetSelection({ db: sqliteDb, appDataStore });

        if (appDataStore.getState().initialized) {
            const fullProjection = appDataStore.exportProjection({ includeMessages: true });
            const idsAssigned = assignMissingPersistentIds(fullProjection);
            // Bookmarks already have a canonical relational store. Ingest the
            // compatibility fields once, then remove them from chat payloads.
            const bookmarkMigration = bookmarkStore.needsLegacyMigration()
                ? bookmarkStore.migrateLegacyDatabase(fullProjection)
                : { changed: false };
            if (idsAssigned || bookmarkMigration.changed) {
                appDataStore.replaceFromProjection(fullProjection, {
                    expectedRevision: appDataStore.getState().revision,
                });
            }
        }
        syncTrashRetention();
    })().catch(error => {
        appDataReadyPromise = null;
        throw error;
    });
    return appDataReadyPromise;
}

// --- Revenant generation jobs -------------------------------------------------
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
    isCloudflareTunnelRequest,
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
    isCloudflareTunnelRequest,
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
    isCloudflareTunnelRequest,
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
    isCloudflareTunnelRequest,
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
    isCloudflareTunnelRequest,
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

require('./routes/system.cjs').installSystemRoutes(app, {
    checkAuth,
    stopTunnel,
});

require('./routes/tunnel.cjs').installTunnelRoutes(app, {
    checkAuth,
    tunnelState,
    stopTunnel,
});

driveRoutes = require('./routes/drive.cjs').installDriveRoutes(app, {
    savePath,
    checkAuth,
    checkDownloadAuth,
    isCloudflareTunnelRequest,
    encodeThumbnail: inlayService.encodeThumbnail,
    getTrashRetentionDays: async () => {
        await ensureCanonicalStorage();
        return readTrashRetentionDays();
    },
});

if (isDevelopment) {
    app.use((req, res, next) => viteDevServer.middlewares(req, res, next));
}

// ─── Express error middleware — must be registered after all routes ─────────
app.use(expressErrorMiddleware);
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
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


// Graceful shutdown: stop running jobs and checkpoint WAL before exit
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

    // Periodically checkpoint WAL to reclaim disk space.
    // TRUNCATE (vs RESTART) shrinks the -wal file on disk, not just the writer
    // pointer — required for journal_size_limit to actually take effect.
    setInterval(() => {
        try { checkpointWal('TRUNCATE'); }
        catch { /* non-fatal */ }
        try { checkpointGenerationDb('PASSIVE'); }
        catch { /* non-fatal */ }
    }, 5 * 60 * 1000);

    // Terminal recovery data is temporary. Keep it for one day, then remove DB
    // metadata and its journal even if no client reconnects.
    setInterval(() => {
        try { pruneRetainedGenerationJobs(); }
        catch (error) { logger.error('[GenerationJob] Retention cleanup failed:', error); }
    }, 60 * 60 * 1000);

})();

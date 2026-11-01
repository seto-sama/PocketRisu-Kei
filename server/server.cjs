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
const { createSyncHub, getSyncClientIdFromRequest, requireSyncClientId } = require('./syncHub.cjs');
const { getMimeFromExt, resolveAssetPayload } = require('./utils/mime.cjs');

const { existsSync, mkdirSync, writeFileSync } = require('fs');
const fs = require('fs/promises')
const nodeCrypto = require('crypto')
const imagePromptFormattingPromise = import('./imagePromptFormatting.mjs')

const { WebSocketServer } = require('ws')
const { Worker } = require('worker_threads')
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
const { kvGet, kvSet, kvSetChunked, kvDel, kvList, checkpointWal, snapshotSetFootprint, db: sqliteDb } = require('./db.cjs');
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
const { addRequestLog, updateRequestLogResponseById } = require('./logs/requestLogs.cjs');
const { recordGenerationUsage } = require('./logs/usageDb.cjs');
const {
    executeEchoProviderRequest,
    executeUpstreamRequest,
    filterUpstreamRequestHeaders,
} = require('./upstreamRequest.cjs');
const { REVENANT_CAPACITY } = require('./revenant/capacity.cjs');

const {
    generationDb,
    getGenerationJob,
    setGenerationJobGenerating,
    setGenerationJobHeaders,
    readGenerationJobRaw,
    replaceGenerationJobEvents,
    setGenerationJobProjection,
    setGenerationJobProjectionError,
    finishGenerationJob,
    finishGenerationWorkflow,
    getGenerationWorkflow,
    cancelGenerationWorkflow,
    cancelGenerationStepExecution,
    listGenerationJobsNeedingProjection,
    pruneRetainedGenerationJobs,
    checkpointGenerationDb,
    generationJournalStore,
    NORMALIZED_PROJECTION_SCHEMA_VERSION,
    projectGenerationJournal,
    openGenerationEventJournal,
    installRevenantGenerationRoutes,
    installImageGenerationJobRoutes,
    createImageGenerationJobService,
    createGenerationWorkers,
    createRevenantMaterializer,
    createRevenantPostprocessWorker,
    createGenerationWorkflowService,
    applyMutationPatch,
    GENERATION_REQUEST_DEFAULT_TIMEOUT_MS,
    normalizeGenerationRequestTimeoutMs,
    notifyRevenantJournalWaiters,
    streamRevenantJournal,
    waitForDrain,
} = require('./revenant/index.cjs');
const { createCanonicalChatService } = require('./chatStore.cjs');
const { applyGenerationInputMetadata } = require('./revenant/generationInputMetadata.cjs');
const { isCloudflareTunnelRequest: isCloudflareTunnelRequestForUrl } = require('./remoteDatabaseFilter.cjs');
const { normalizeTrashRetentionDays } = require('../shared/trashRetention.mjs');

const { decodeRisuSave, encodeRisuSaveLegacy } = require('./utils/risuSave.cjs');
const { normalizeJSON } = require('./utils/json.cjs');
const {
    exportPromptPresetSelection,
    importPromptPresetSelection,
} = require('../shared/promptPresetSelection.mjs');
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

// ─── Server-side database backup (DB-only snapshots) ────────────────────────
//
// Snapshots live as `database/dbbackup-{ts}.bin` keys inside the kv table.
// They're created on every successful persist (with a cooldown) and rotated
// to fit user-configured count/size limits — see SNAPSHOT_LIMIT_* below.
const DB_BACKUP_PREFIX = 'database/dbbackup-';
const SNAPSHOT_LIMIT_COUNT_KEY = 'config/snapshot-max-count';
const SNAPSHOT_LIMIT_BYTES_KEY = 'config/snapshot-max-bytes';
const SNAPSHOT_LIMIT_DEFAULT_COUNT = 20;
const SNAPSHOT_LIMIT_DEFAULT_BYTES = 500 * 1024 * 1024;
// Safety bounds to keep a stray PUT from making the system unusable.
const SNAPSHOT_LIMIT_MIN_COUNT = 1;
const SNAPSHOT_LIMIT_MAX_COUNT = 100;
const SNAPSHOT_LIMIT_MIN_BYTES = 10 * 1024 * 1024;
const SNAPSHOT_LIMIT_MAX_BYTES = 50 * 1024 * 1024 * 1024;
const BACKUP_INTERVAL_MS = process.env.POCKETRISU_BACKUP_INTERVAL_MS
    ? Number(process.env.POCKETRISU_BACKUP_INTERVAL_MS)
    : 5 * 60 * 1000;
let lastBackupTime = null;
let backupRotationScheduled = false;

function readSnapshotConfigInt(key, fallback, min, max) {
    try {
        const raw = kvGet(key);
        if (!raw) return fallback;
        const n = parseInt(Buffer.from(raw).toString('utf-8').trim(), 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    } catch { return fallback; }
}

function getSnapshotLimits() {
    return {
        maxCount: readSnapshotConfigInt(
            SNAPSHOT_LIMIT_COUNT_KEY, SNAPSHOT_LIMIT_DEFAULT_COUNT,
            SNAPSHOT_LIMIT_MIN_COUNT, SNAPSHOT_LIMIT_MAX_COUNT,
        ),
        maxBytes: readSnapshotConfigInt(
            SNAPSHOT_LIMIT_BYTES_KEY, SNAPSHOT_LIMIT_DEFAULT_BYTES,
            SNAPSHOT_LIMIT_MIN_BYTES, SNAPSHOT_LIMIT_MAX_BYTES,
        ),
    };
}

function deleteSnapshotStateRows(key) {
    kvDel(key);
    bookmarkStore.deleteSnapshot(key);
}

const deleteSnapshotStates = sqliteDb.transaction((keys) => {
    for (const key of keys) deleteSnapshotStateRows(key);
});

// Walk newest → oldest; keep within both limits, delete the rest. The most
// recent snapshot is always kept (even if it alone exceeds the byte limit) so
// we never end up with zero backups after a config change.
function trimSnapshotsToLimits() {
    const { maxCount, maxBytes } = getSnapshotLimits();
    const entries = kvList(DB_BACKUP_PREFIX)
        .map((key) => {
            const tsRaw = parseInt(key.slice(DB_BACKUP_PREFIX.length, -4), 10);
            return { key, ts: Number.isFinite(tsRaw) ? tsRaw : 0 };
        })
        .sort((a, b) => b.ts - a.ts);

    const keptKeys = [];
    const toDelete = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const isFirst = i === 0;
        const fitsByCount = keptKeys.length < maxCount;
        // Compute the physical union of all kept snapshots. Content-addressed
        // chunks shared by two snapshots occupy disk once, not once per key.
        const candidateBytes = snapshotSetFootprint([...keptKeys, e.key]);
        const fitsByBytes = candidateBytes <= maxBytes;
        if (isFirst || (fitsByCount && fitsByBytes)) {
            keptKeys.push(e.key);
        } else {
            toDelete.push(e.key);
        }
    }
    deleteSnapshotStates(toDelete);
    return { kept: entries.length - toDelete.length, removed: toDelete.length };
}

function makeSnapshotKey(now = Date.now()) {
    let tick = Math.round(now / 100);
    let key = `${DB_BACKUP_PREFIX}${tick}.bin`;
    while (kvGet(key)) {
        tick += 1;
        key = `${DB_BACKUP_PREFIX}${tick}.bin`;
    }
    return key;
}

const createSnapshotState = sqliteDb.transaction(() => {
    if (!appDataStore.getState().initialized) {
        throw new Error('Cannot create snapshot: relational database is missing');
    }
    const backupKey = makeSnapshotKey();
    const projection = appDataStore.exportProjection({ includeMessages: true });
    bookmarkStore.projectDatabaseCompatibility(projection);
    kvSetChunked(backupKey, Buffer.from(encodeRisuSaveLegacy(
        exportPromptPresetSelection(projection),
    )));
    if (!kvGet(backupKey)) throw new Error('Cannot create snapshot: database blob is missing');
    bookmarkStore.saveSnapshot(backupKey);
    trimSnapshotsToLimits();
    return backupKey;
});

function createBackupAndRotate() {
    const now = Date.now();
    if (lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS) {
        return;
    }
    lastBackupTime = now;

    createSnapshotState();
}

function scheduleBackupAndRotate() {
    const now = Date.now();
    if (backupRotationScheduled
        || (lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS)) {
        return;
    }
    backupRotationScheduled = true;
    lastBackupTime = now;
    setImmediate(() => {
        const limits = getSnapshotLimits();
        const worker = new Worker(path.join(__dirname, 'snapshotWorker.cjs'), {
            workerData: {
                dbPath: path.join(process.cwd(), 'save', 'risuai.db'),
                prefix: DB_BACKUP_PREFIX,
                maxCount: limits.maxCount,
                maxBytes: limits.maxBytes,
            },
        });
        let reported = false;
        worker.once('message', message => {
            reported = true;
            if (!message?.ok) {
                lastBackupTime = null;
                logger.warn('[Snapshot] Worker rotation failed:', message?.error ?? 'unknown error');
            }
        });
        worker.once('error', error => {
            reported = true;
            lastBackupTime = null;
            logger.warn('[Snapshot] Worker failed:', error);
        });
        worker.once('exit', code => {
            if (!reported && code !== 0) {
                lastBackupTime = null;
                logger.warn(`[Snapshot] Worker exited with code ${code}`);
            }
            backupRotationScheduled = false;
        });
    });
}

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

// Server-side backup directory (outside save/ to avoid bloating updater copies).
// Configurable at runtime via the kv key `config/server-backup-path`. When the
// user changes the path the old directory is left in place (existing backups
// stay where they were); only future backups land at the new path.
const DEFAULT_BACKUPS_DIR = path.join(process.cwd(), "backups");
const BACKUP_PATH_CONFIG_KEY = 'config/server-backup-path';

// Plaintext marker the updater reads to preserve a custom in-tree backup dir
// during in-place updates. KV lives inside the SQLite DB so the updater (which
// runs without npm deps) can't read it; this marker bridges that gap.
const BACKUP_PATH_MARKER = path.join(savePath, '__backup_path');

function readBackupsDirConfig() {
    try {
        const raw = kvGet(BACKUP_PATH_CONFIG_KEY);
        if (!raw) return DEFAULT_BACKUPS_DIR;
        const text = Buffer.from(raw).toString('utf-8').trim();
        return text || DEFAULT_BACKUPS_DIR;
    } catch { return DEFAULT_BACKUPS_DIR; }
}

function writeBackupPathMarker(absPath) {
    try {
        writeFileSync(BACKUP_PATH_MARKER, absPath, 'utf-8');
    } catch {
        // Best-effort; without the marker the updater keeps only `backups`.
    }
}

const backupState = {
    backupsDir: readBackupsDirConfig(),
};
if(!existsSync(backupState.backupsDir)){
    try { mkdirSync(backupState.backupsDir, { recursive: true }); }
    catch { backupState.backupsDir = DEFAULT_BACKUPS_DIR; mkdirSync(backupState.backupsDir, { recursive: true }); }
}
writeBackupPathMarker(backupState.backupsDir);
const BACKUP_FILENAME_REGEX = /^risu-backup-\d+\.bin$/;

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
    normalizeInlayImageSettings,
    encodeInlayImageBuffer,
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

// --- Generation Job constants ---
const GENERATION_JOB_DEFAULT_HEARTBEAT_SEC = 15;
const GENERATION_JOB_HEARTBEAT_MIN_SEC = 5;
const GENERATION_JOB_HEARTBEAT_MAX_SEC = 60;
const GENERATION_JOB_GC_INTERVAL_MS = 60000;
const GENERATION_JOB_DONE_GRACE_MS = 30000;
const generationRuntimeJobs = new Map();
let imageGenerationJobService;

function countActiveProviderJobs() {
    let count = imageGenerationJobService?.countActiveJobs() ?? 0;
    for (const job of generationRuntimeJobs.values()) {
        if (!job.done && !job.waitingDispatch) count += 1;
    }
    return count;
}



// --- Generation: auth helpers ---

// WebSocket clients may pass the token as a query parameter because browsers
// cannot set custom headers on the upgrade request.
function isAuthorizedUpgrade(req, reqUrl) {
    const header = Array.isArray(req.headers['risu-auth'])
        ? req.headers['risu-auth'][0]
        : req.headers['risu-auth'];
    const auth = reqUrl.searchParams.get('risu-auth') || (typeof header === 'string' ? header : '');
    return checkAuth({ headers: { 'risu-auth': auth } }, null, true);
}

function sanitizeGenerationTargetUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

// --- Generation: request/response helpers ---

function normalizeForwardHeaders(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    return filterUpstreamRequestHeaders(Object.fromEntries(
        Object.entries(input).filter(([, value]) => typeof value === 'string'),
    ));
}

function normalizeHeartbeatSec(heartbeatSec) {
    if (!Number.isFinite(heartbeatSec)) {
        return GENERATION_JOB_DEFAULT_HEARTBEAT_SEC;
    }
    const parsed = Math.floor(heartbeatSec);
    return Math.min(GENERATION_JOB_HEARTBEAT_MAX_SEC, Math.max(GENERATION_JOB_HEARTBEAT_MIN_SEC, parsed));
}

function hasGenerationStreamTerminalMarker(rawBuffer) {
    const text = Buffer.from(rawBuffer || '').toString('utf-8');
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return true;
        if (!data) continue;
        try {
            const payload = JSON.parse(data);
            if (
                payload?.type === 'message_stop'
                || payload?.type === 'response.completed'
                || payload?.type === 'response.done'
            ) {
                return true;
            }
            if (payload?.candidates?.some(candidate =>
                typeof candidate?.finishReason === 'string'
                && candidate.finishReason !== ''
                && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED'
            )) {
                return true;
            }
        } catch {
            // Partial/non-JSON SSE event.
        }
    }
    return false;
}

// --- Generation: job lifecycle ---

function createGenerationRuntimeJob(arg) {
    const jobId = arg.jobId || nodeCrypto.randomUUID();
    const timeoutMs = normalizeGenerationRequestTimeoutMs(Number(arg.timeoutMs));
    const heartbeatSec = normalizeHeartbeatSec(arg.heartbeatSec);
    const controller = new AbortController();
    const createdAt = Date.now();
    const job = {
        id: jobId,
        workflowId: arg.workflowId || null,
        createdAt,
        updatedAt: createdAt,
        done: false,
        cleanupAt: 0,
        clients: new Set(),
        rawBytes: 0,
        journalWaiters: [],
        providerStartedAt: null,
        responseStatus: null,
        responseHeaders: {},
        terminalEvent: null,
        abortController: controller,
        cancelUpstream: null,
        deadlineAt: createdAt + timeoutMs,
        heartbeatSec,
        timeoutMs
    };
    generationRuntimeJobs.set(jobId, job);
    return job;
}

function loadPersistedGenerationRuntimeJob(jobId) {
    const persisted = getGenerationJob(jobId, false);
    if (!persisted) return null;
    const createdAt = persisted.createdAt || Date.now();
    const active = ['queued', 'generating'].includes(persisted.status);
    const job = {
        id: jobId,
        workflowId: persisted.workflowId || null,
        createdAt,
        updatedAt: persisted.updatedAt || createdAt,
        done: !active,
        waitingDispatch: persisted.status === 'queued',
        cleanupAt: active ? 0 : Date.now() + GENERATION_JOB_DONE_GRACE_MS,
        clients: new Set(),
        rawBytes: persisted.rawBytes || 0,
        journalWaiters: [],
        providerStartedAt: persisted.dispatchedAt || null,
        responseStatus: persisted.responseStatus || null,
        responseHeaders: persisted.responseHeaders || {},
        terminalEvent: active ? null : persisted.status === 'failed'
            ? {
                type: 'error',
                status: 502,
                message: persisted.error || 'Generation job failed',
            }
            : {
                type: 'done',
                status: persisted.status,
                partial: ['cancelled', 'interrupted', 'failed_partial'].includes(persisted.status),
                finishReason: persisted.finishReason,
            },
        abortController: new AbortController(),
        cancelUpstream: null,
        deadlineAt: Date.now(),
        heartbeatSec: GENERATION_JOB_DEFAULT_HEARTBEAT_SEC,
        timeoutMs: GENERATION_REQUEST_DEFAULT_TIMEOUT_MS,
    };
    generationRuntimeJobs.set(jobId, job);
    return job;
}

function notifyGenerationJob(job) {
    job.updatedAt = Date.now();
    notifyRevenantJournalWaiters(job);
}

function markGenerationJobDone(job) {
    if (job.done) return;
    job.done = true;
    job.cleanupAt = Date.now() + GENERATION_JOB_DONE_GRACE_MS;
    notifyRevenantJournalWaiters(job);
}

function cleanupGenerationRuntimeJob(jobId) {
    const job = generationRuntimeJobs.get(jobId);
    if (!job) return;
    for (const client of job.clients) {
        try { client.close(); } catch { /* ignore */ }
    }
    generationRuntimeJobs.delete(jobId);
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

function currentServerImageGenerationSettings() {
    const database = appDataStore.exportProjection({ includeMessages: false });
    const preset = database.imageGenerationPresets?.[database.imageGenerationPresetId]
        ?? database.imageGenerationPresets?.[0];
    const settings = preset?.settings;
    if (!settings || typeof settings !== 'object') {
        throw new Error('Image generation preset is not configured');
    }
    const keyRef = settings.imageApiKeyRefs?.novelai;
    const apiKey = String(database.apiKeyPool?.[keyRef]?.key ?? settings.NAIApiKey ?? '').trim();
    return {
        settings: structuredClone(settings),
        apiKey,
        label: typeof preset.name === 'string' ? preset.name : String(settings.sdProvider || 'Image'),
        inlaySettings: normalizeInlayImageSettings({
            size: database.inlayImageCompression ? database.inlayImageSize : 'original',
            format: database.inlayImageCompression ? database.inlayImageFormat : 'png',
            lossy: database.inlayImageLossy,
            quality: database.inlayImageQuality,
        }),
    };
}

function imageGenerationSeed(provider, requestedSeed) {
    if (Number.isFinite(requestedSeed) && requestedSeed >= 0) return requestedSeed;
    const value = nodeCrypto.randomBytes(4).readUInt32BE(0);
    return provider === 'comfyui' ? value % 1_000_000_000 : value;
}

const IMAGE_INLAY_UUID_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

function imageInlayId(jobId) {
    const bytes = nodeCrypto.createHash('sha1')
        .update(IMAGE_INLAY_UUID_NAMESPACE)
        .update(`pocketrisu:image-inlay:${jobId}`)
        .digest()
        .subarray(0, 16);
    // Keep the ID deterministic for workflow recovery while matching the UUID
    // shape used by regular inlay assets. Mark it as a name-based UUID (v5).
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readServerImageReference(reference) {
    if (typeof reference !== 'string' || !reference) return null;
    if (reference.startsWith('data:')) {
        const comma = reference.indexOf(',');
        return comma >= 0 ? Buffer.from(reference.slice(comma + 1), 'base64') : null;
    }
    const inlayMatch = reference.match(/\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/);
    if (inlayMatch) return (await readInlayFile(inlayMatch[1]))?.buffer || null;
    const stored = kvGet(reference);
    if (!stored) return null;
    if (reference.startsWith('inlay/')) {
        return resolveAssetPayload(reference, stored).binary;
    }
    return Buffer.from(stored);
}

async function prepareNovelAIDirectorReference(buffer) {
    const vips = await getVips();
    const source = vips.Image.newFromBuffer(buffer);
    let rotated = null;
    let resized = null;
    let embedded = null;
    try {
        rotated = source.autorot();
        const scale = Math.min(1472 / rotated.width, 1472 / rotated.height);
        resized = scale === 1 ? rotated : rotated.resize(scale, { kernel: vips.Kernel.lanczos3 });
        const x = Math.floor((1472 - resized.width) / 2);
        const y = Math.floor((1472 - resized.height) / 2);
        embedded = resized.embed(x, y, 1472, 1472, { extend: vips.Extend.black });
        return Buffer.from(embedded.writeToBuffer('.png', { Q: 100 }));
    } finally {
        if (embedded) embedded.delete();
        if (resized && resized !== rotated) resized.delete();
        if (rotated) rotated.delete();
        source.delete();
    }
}

async function executeServerImageAction({ workflow, action }) {
    const payload = action?.payload || {};
    const imageContext = workflow.context?.kind === 'image-generation' ? workflow.context : undefined;
    const target = payload.target || (imageContext
        ? imageContext.target
        : {
            characterId: workflow.characterId,
            roomId: workflow.roomId,
        });
    if (!target?.characterId || !target?.roomId) throw new Error('Image generation target is missing');
    const config = currentServerImageGenerationSettings();
    const provider = config.settings.sdProvider;
    const seed = imageGenerationSeed(provider, payload.seed);
    const jobId = `${workflow.workflowId}:${action.actionId}`;
    let references;
    if (provider === 'novelai') {
        const database = appDataStore.exportProjection({ includeMessages: false });
        const character = database.characters?.find(item => item?.chaId === target.characterId);
        const imageConfig = config.settings.NAIImgConfig || {};
        const fallbackImage = character?.image;
        const initImage = config.settings.NAII2I
            ? await readServerImageReference(imageConfig.image || fallbackImage)
            : null;
        const rawDirectorReference = imageConfig.reference_mode === 'reference'
            ? await readServerImageReference(imageConfig.character_image || fallbackImage)
            : null;
        const directorReference = rawDirectorReference
            ? await prepareNovelAIDirectorReference(rawDirectorReference)
            : null;
        references = {
            ...(initImage ? { initImageBase64: initImage.toString('base64') } : {}),
            ...(directorReference
                ? { directorReferenceBase64: directorReference.toString('base64') }
                : {}),
        };
    }
    const promptFormatting = await imagePromptFormattingPromise;
    const rawPrompt = String(payload.prompt || '');
    const requestPrompt = provider === 'novelai'
        ? promptFormatting.formatNovelAIPrompt(rawPrompt, config.settings.animaArtistTagCompatibility === true)
        : provider === 'comfyui'
            ? promptFormatting.formatComfyUIPrompt(rawPrompt, config.settings.animaArtistTagCompatibility === true)
            : rawPrompt;
    const negativePrompt = String(payload.negativePrompt || '');
    const generated = await imageGenerationJobService.executeImageGeneration({
        jobId,
        settings: provider === 'comfyui' ? {
            sdProvider: 'comfyui',
            comfyConfig: { timeout: config.settings.comfyConfig?.timeout },
        } : config.settings,
        apiKey: config.apiKey,
        prompt: requestPrompt,
        negativePrompt,
        orientation: payload.orientation,
        seed,
        references,
        bridgeId: payload.bridgeId || workflow.context?.comfyBridgeId,
    });
    let encoded;
    try {
        encoded = await encodeInlayImageBuffer(generated.image, config.inlaySettings);
    } finally {
        imageGenerationJobService.releaseResult(jobId);
    }
    const inlayId = imageInlayId(jobId);
    await writeInlayFile(inlayId, encoded.ext, encoded.buffer, {
        name: inlayId,
        type: 'image',
        width: encoded.width,
        height: encoded.height,
    });
    const now = Date.now();
    kvSet(`inlay_meta/${inlayId}`, Buffer.from(JSON.stringify({
        createdAt: now,
        updatedAt: now,
        charId: target.characterId,
        chatId: target.roomId,
        imageGeneration: { prompt: requestPrompt, negativePrompt, seed, preset: imageContext?.preset },
    })));
    const reference = `{{inlayed::${inlayId}}}`;
    const projection = imageContext
        ? imageContext.projection || 'append'
        : undefined;
    if (projection === 'append' || projection === 'reroll') {
        await canonicalChatService.commitServerMutation({
            characterId: target.characterId,
            chatId: target.roomId,
            reason: 'image-generation-result',
            mutate: chat => {
                const messageId = String(payload.messageId || '');
                if (projection === 'reroll') {
                    const message = chat.message.find(item => item?.chatId === messageId);
                    if (!message || message.kind !== 'imageGeneration') {
                        throw new Error('Image reroll target no longer exists');
                    }
                    const swipes = message.swipes ?? [message.data];
                    message.swipes = swipes.includes(reference) ? swipes : [...swipes, reference];
                    message.swipeId = message.swipes.indexOf(reference);
                    message.data = reference;
                    message.time = now;
                }
                else if (!chat.message.some(item => item?.chatId === messageId)) {
                    chat.message.push({
                        role: 'char',
                        data: reference,
                        kind: 'imageGeneration',
                        saying: target.characterId,
                        chatId: messageId,
                        time: now,
                    });
                }
                return chat;
            },
        });
    }
    return { reference, jobId, seed, label: config.label };
}

function scheduleImageGenerationWorkflow(workflowId) {
    void (async () => {
        const workflow = getGenerationWorkflow(workflowId);
        const step = workflow?.steps?.find(item => item.key === 'image.generate');
        const action = step?.metadata?.action;
        if (!workflow || !step || !action) return;
        try {
            const result = await executeServerImageAction({ workflow, action });
            generationDb.updateGenerationWorkflowStep(workflowId, step.key, {
                status: 'completed',
                metadata: { ...step.metadata, schemaVersion: 1, result },
            });
            finishGenerationWorkflow(workflowId, 'completed');
        }
        catch (error) {
            generationDb.updateGenerationWorkflowStep(workflowId, step.key, {
                status: 'failed',
                metadata: {
                    ...step.metadata,
                    schemaVersion: 1,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
            finishGenerationWorkflow(workflowId, 'failed');
        }
        broadcastRevenantWorkflowUpdated(getGenerationWorkflow(workflowId));
    })();
}
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

const resolveProviderAuth = require('./googleServiceAccount.cjs').createServerProviderAuthResolver();

async function runGenerationProviderJob(job, arg) {
    const targetUrl = sanitizeGenerationTargetUrl(arg.targetUrl);
    if (!targetUrl) {
        finishGenerationJob(job.id, 'failed', 'invalid_target', 'Invalid target URL');
        markGenerationJobDone(job);
        return;
    }

    const headers = normalizeForwardHeaders(arg.headers);
    const bodyBuffer = arg.body?.length
        ? Buffer.from(arg.body.buffer, arg.body.byteOffset, arg.body.byteLength)
        : undefined;
    let completionProbe = Buffer.alloc(0);
    let providerCompleted = false;
    let eventJournal = null;
    const journalWriter = generationJournalStore.openWriter(job.workflowId, job.id);
    let journalWriteError = null;
    let journalClosed = false;
    journalWriter?.on('error', (error) => {
        journalWriteError ||= error;
        notifyRevenantJournalWaiters(job);
    });
    const closeJournal = async () => {
        if (journalClosed) return;
        journalClosed = true;
        if (!journalWriter.destroyed) {
            await new Promise((resolve) => {
                const done = () => {
                    journalWriter.off('close', done);
                    resolve();
                };
                journalWriter.once('close', done);
                journalWriter.end();
            });
        }
        notifyRevenantJournalWaiters(job);
        if (journalWriteError) throw journalWriteError;
    };
    const recordUsage = (persisted, rawResponse, outputText) => recordGenerationUsage({
        jobId: job.id,
        timestamp: persisted?.createdAt,
        chatId: persisted?.chatId,
        targetUrl,
        body: arg.body,
        rawResponse,
        outputText,
        usageProviderId: arg.usageProviderId,
        usageModelId: arg.usageModelId,
        usageServiceTier: arg.usageServiceTier,
    });

    try {
        await resolveProviderAuth(arg.serverProviderAuth, headers, job.abortController.signal);
        job.providerStartedAt ||= Date.now();
        notifyRevenantJournalWaiters(job);
        setGenerationJobGenerating(job.id);
        addRequestLog({
            id: job.id,
            timestamp: job.providerStartedAt,
            date: new Date(job.providerStartedAt).toLocaleTimeString(),
            url: targetUrl,
            body: bodyBuffer?.toString('utf-8') || '',
            header: JSON.stringify(headers, null, 2),
            response: 'Streamed Fetch',
            responseType: 'stream',
            success: true,
            chatId: arg.requestLog?.chatId,
            clientId: arg.requestLog?.clientId,
            platform: arg.requestLog?.platform,
        });
        const providerRequest = {
            url: targetUrl,
            method: arg.method,
            headers,
            body: bodyBuffer && arg.method !== 'GET' && arg.method !== 'HEAD' ? bodyBuffer : undefined,
            signal: job.abortController.signal,
            outboundPolicy,
        };
        const upstreamResponse = arg.adapterKind === 'echo'
            ? await executeEchoProviderRequest(providerRequest)
            : await executeUpstreamRequest(providerRequest);
        const filteredHeaders = upstreamResponse.headers;

        setGenerationJobHeaders(job.id, upstreamResponse.status, filteredHeaders);
        job.responseStatus = upstreamResponse.status;
        job.responseHeaders = filteredHeaders;
        const decodable = getGenerationJob(job.id, false);
        if (decodable?.responseDecoder && upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
            eventJournal = openGenerationEventJournal(decodable, {
                journalStore: generationJournalStore,
                onWritten: () => notifyRevenantJournalWaiters(job),
            });
        }
        notifyGenerationJob(job);

        if (upstreamResponse.body) {
            const iterator = upstreamResponse.body[Symbol.asyncIterator]();
            let upstreamDone = false;
            let cancelPromise = null;
            const cancelUpstream = (reason) => {
                if (upstreamDone || typeof iterator.return !== 'function') return Promise.resolve();
                cancelPromise ||= Promise.resolve(iterator.return(reason)).then(() => {});
                return cancelPromise;
            };
            job.cancelUpstream = cancelUpstream;
            try {
                while (!job.abortController.signal.aborted) {
                    const next = await iterator.next();
                    if (next.done) {
                        upstreamDone = true;
                        break;
                    }
                    const value = next.value;
                    if (value && value.length > 0) {
                        const bytes = Buffer.from(value);
                        completionProbe = Buffer.concat([completionProbe, bytes]);
                        if (completionProbe.length > 256 * 1024) {
                            completionProbe = completionProbe.subarray(completionProbe.length - 256 * 1024);
                        }
                        if (journalWriteError) throw journalWriteError;
                        job.rawBytes += bytes.length;
                        eventJournal?.push(bytes);
                        const writable = journalWriter.write(bytes, () => {
                            notifyRevenantJournalWaiters(job);
                        });
                        if (!writable) await waitForDrain(journalWriter);
                        await eventJournal?.ready();
                        notifyGenerationJob(job);
                        if (hasGenerationStreamTerminalMarker(completionProbe)) {
                            providerCompleted = true;
                            break;
                        }
                    }
                }
            } finally {
                if (!upstreamDone) {
                    await cancelUpstream(job.abortController.signal.reason);
                }
                if (job.cancelUpstream === cancelUpstream) job.cancelUpstream = null;
            }
        }
        await closeJournal();
        const providerCompletedAt = Date.now();
        const cancelled = job.abortController.signal.aborted;
        const persisted = getGenerationJob(job.id, false);
        const cancelFinishReason = persisted?.finishReason || 'user_cancelled';
        const rawResponse = readGenerationJobRaw(job.id);
        let projection = persisted?.projection;
        let terminalFailure;
        if (!cancelled && (upstreamResponse.status < 200 || upstreamResponse.status >= 300)) {
            terminalFailure = {
                finishReason: 'upstream_http_error',
                message: `Provider request failed with HTTP ${upstreamResponse.status}`,
            };
        } else if (eventJournal) {
            try {
                projection = await eventJournal.finish(cancelled);
                setGenerationJobProjection(job.id, projection);
            } catch (error) {
                const message = `Failed to normalize provider journal: ${error}`;
                setGenerationJobProjectionError(job.id, message);
                if (!cancelled) {
                    terminalFailure = { finishReason: 'projection_error', message };
                } else {
                    logger.warn(`[GenerationJob] Cancelled projection unavailable for ${job.id}:`, error);
                }
            }
        }
        updateRequestLogResponseById(
            job.id,
            rawResponse.toString('utf-8'),
            upstreamResponse.status,
            upstreamResponse.status >= 200 && upstreamResponse.status < 400,
            providerCompletedAt,
        );
        recordUsage(persisted, rawResponse, projection?.content);
        const finishReason = cancelled
            ? cancelFinishReason
            : (providerCompleted ? 'provider_complete' : 'upstream_complete');
        if (terminalFailure) {
            finishGenerationJob(
                job.id,
                'failed',
                terminalFailure.finishReason,
                terminalFailure.message,
                rawResponse.length,
            );
        } else {
            finishGenerationJob(
                job.id,
                cancelled ? 'cancelled' : 'generated',
                finishReason,
                null,
                rawResponse.length,
            );
        }
        // A non-2xx upstream response is still a complete HTTP response, and a
        // decoding failure is the last decoded event. Close the journal
        // normally so the client adapter can read the provider's error body or
        // the decoder's error and surface the precise message instead of a
        // transport level fallback. The job remains failed in durable storage.
        if (['upstream_http_error', 'projection_error'].includes(terminalFailure?.finishReason)) {
            job.terminalEvent = {
                type: 'done',
                status: 'failed',
                partial: false,
                finishReason: terminalFailure.finishReason,
            };
        } else if (terminalFailure) {
            job.terminalEvent = {
                type: 'error',
                status: 502,
                message: terminalFailure.message,
            };
        } else {
            job.terminalEvent = {
                type: 'done',
                status: cancelled ? 'cancelled' : 'generated',
                partial: cancelled,
                finishReason,
            };
        }
        markGenerationJobDone(job);
        scheduleHypaWorkflowExecution();
        scheduleRevenantPostprocess();
    } catch (error) {
        job.cancelUpstream = null;
        try { await closeJournal(); } catch (persistError) {
            logger.error('[GenerationJob] Failed to close partial response journal:', persistError);
        }
        const cancelled = job.abortController.signal.aborted;
        const message = cancelled ? 'Generation job aborted' : `${error}`;
        if (eventJournal) {
            try {
                setGenerationJobProjection(job.id, await eventJournal.finish(true));
            } catch (projectionError) {
                logger.warn(`[GenerationJob] Partial projection unavailable for ${job.id}:`, projectionError);
            }
        }
        const persistedWithRaw = getGenerationJob(job.id, false);
        const rawResponse = readGenerationJobRaw(job.id);
        updateRequestLogResponseById(
            job.id,
            rawResponse.length > 0 ? rawResponse.toString('utf-8') : message,
            persistedWithRaw?.responseStatus,
            false,
        );
        recordUsage(persistedWithRaw, rawResponse, persistedWithRaw?.projection?.content);
        const hasPartial = rawResponse.length > 0;
        const cancelFinishReason = persistedWithRaw?.finishReason || 'user_cancelled';
        finishGenerationJob(
            job.id,
            cancelled ? 'cancelled' : (hasPartial ? 'failed_partial' : 'failed'),
            cancelled ? cancelFinishReason : 'upstream_error',
            message,
            rawResponse.length,
        );
        job.rawBytes = rawResponse.length;
        job.terminalEvent = cancelled
            ? {
                type: 'done',
                status: 'cancelled',
                partial: true,
                finishReason: cancelFinishReason,
            }
            : { type: 'error', status: 504, message };
        markGenerationJobDone(job);
        scheduleHypaWorkflowExecution();
    }
}

// --- Generation: WebSocket setup ---

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
            const job = generationRuntimeJobs.get(jobId) || loadPersistedGenerationRuntimeJob(jobId);
            if (!job) {
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

    wsServer.on('connection', (ws, req, jobId) => {
        const job = generationRuntimeJobs.get(jobId) || loadPersistedGenerationRuntimeJob(jobId);
        if (!job) {
            ws.close();
            return;
        }

        const reqUrl = new URL(req.url, `http://${req.headers.host}`);
        ws.journalRecoverySubscriber = reqUrl.searchParams.get('recovery') === '1';
        job.clients.add(ws);
        ws.send(JSON.stringify({ type: 'job_accepted', jobId }));
        void streamRevenantJournal(
            ws,
            job,
            Number(reqUrl.searchParams.get('offset')),
            reqUrl.searchParams.get('format') === 'events' ? 'events' : 'journal',
        ).catch((error) => {
            logger.error(`[GenerationJob] Failed to stream journal ${jobId}:`, error);
            try { ws.close(); } catch { /* ignore */ }
        });

        const pingTimer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }, job.heartbeatSec * 1000);

        ws.on('close', () => {
            clearInterval(pingTimer);
            const currentJob = generationRuntimeJobs.get(jobId);
            if (!currentJob) return;
            currentJob.clients.delete(ws);
        });

        ws.on('error', () => {
            clearInterval(pingTimer);
        });
    });
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

async function rebuildMissingGenerationProjections() {
    const jobs = listGenerationJobsNeedingProjection(
        200,
        NORMALIZED_PROJECTION_SCHEMA_VERSION,
    );
    let rebuilt = 0;
    for (const job of jobs) {
        const rawResponse = readGenerationJobRaw(job.jobId);
        try {
            const { projection, events } = await projectGenerationJournal(job, rawResponse);
            replaceGenerationJobEvents(job.jobId, events);
            setGenerationJobProjection(job.jobId, projection);
            if (job.status === 'failed' && job.finishReason === 'projection_error') {
                finishGenerationJob(
                    job.jobId,
                    'generated',
                    'projection_rebuilt',
                    null,
                    rawResponse.length,
                );
            }
            rebuilt += 1;
        } catch (error) {
            setGenerationJobProjectionError(
                job.jobId,
                `Failed to rebuild normalized projection: ${error}`,
            );
        }
    }
    if (rebuilt > 0) {
        logger.info(`[GenerationJob] Rebuilt ${rebuilt} normalized projection(s) from raw journals`);
    }
}

// Graceful shutdown: stop running jobs and checkpoint WAL before exit
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
        console.log(`[Server] Received ${sig}, flushing pending data...`);
        await viteDevServer?.close();
        stopTunnel();
        await driveRoutes.stopTrashCleanup();
        const generationRuns = [];
        for (const job of generationRuntimeJobs.values()) {
            if (job.done) continue;
            job.abortController.abort();
            if (job.runPromise) generationRuns.push(job.runPromise);
        }
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
    try { await rebuildMissingGenerationProjections(); }
    catch (error) { logger.error('[GenerationJob] Initial projection rebuild failed:', error); }
    try { pruneRetainedGenerationJobs(); }
    catch (error) { logger.error('[GenerationJob] Initial retention cleanup failed:', error); }
    scheduleGenerationDispatch();
    scheduleHypaWorkflowExecution();
    scheduleRevenantPostprocess();

    // In-memory generation runtime garbage collection
    setInterval(() => {
        const now = Date.now();
        for (const [jobId, job] of generationRuntimeJobs.entries()) {
            if (!job.done && !job.waitingDispatch && now >= job.deadlineAt && !job.abortController.signal.aborted) {
                job.abortController.abort();
            }
            if (job.done && job.clients.size === 0 && job.cleanupAt > 0 && now >= job.cleanupAt) {
                cleanupGenerationRuntimeJob(jobId);
                continue;
            }
            if (!job.done && !job.waitingDispatch
                && now - job.updatedAt > Math.max(GENERATION_REQUEST_DEFAULT_TIMEOUT_MS, job.timeoutMs * 2)) {
                cleanupGenerationRuntimeJob(jobId);
            }
        }
    }, GENERATION_JOB_GC_INTERVAL_MS);

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

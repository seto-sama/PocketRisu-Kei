const express = require('express');

const app = express();
const http = require('http');
const https = require('https');
const path = require('path');
const compression = require('compression');

const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } = require('fs');
const fs = require('fs/promises')
const nodeCrypto = require('crypto')

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
const { kvGet, kvSet, kvSetChunked, kvDel, kvList, kvListWithSizes, checkpointWal, snapshotSetFootprint, db: sqliteDb } = require('./db.cjs');
const { createAppDataStore } = require('./appDataStore.cjs');
const {
    AppDataMigrationCleanupError,
    createAppDataMigration,
} = require('./appDataMigration.cjs');
const appDataStore = createAppDataStore(sqliteDb);

const { createBookmarkStore } = require('./bookmarkStore.cjs');
const bookmarkStore = createBookmarkStore(sqliteDb);

const { logger, installProcessHandlers, expressErrorMiddleware } = require('./logs/logs.cjs');
const { addRequestLog, updateRequestLogResponseById } = require('./logs/requestLogs.cjs');
const { recordGenerationUsage } = require('./logs/usageDb.cjs');
const {
    executeEchoProviderRequest,
    executeUpstreamRequest,
} = require('./upstreamRequest.cjs');

const {
    generationDb,
    getGenerationJob,
    setGenerationJobGenerating,
    setGenerationJobHeaders,
    readGenerationJobRaw,
    setGenerationJobProjection,
    setGenerationJobProjectionError,
    finishGenerationJob,
    finishGenerationWorkflow,
    getGenerationWorkflow,
    getActiveGenerationWorkflow,
    cancelGenerationWorkflow,
    cancelGenerationStepExecution,
    listGenerationJobsNeedingProjection,
    pruneRetainedGenerationJobs,
    checkpointGenerationDb,
    generationJournalStore,
    NORMALIZED_PROJECTION_SCHEMA_VERSION,
    projectGenerationJournal,
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
} = require('./revenant/index.cjs');
const { computeChatEtag, commitChatContent, mergeChatStubWithFullChat, reassembleFullDb: reassembleFullDbFromStore, createCanonicalChatService } = require('./chatStore.cjs');
const { applyGenerationInputMetadata } = require('./revenant/generationInputMetadata.cjs');
const { isCloudflareTunnelRequest: isCloudflareTunnelRequestForUrl } = require('./remoteDatabaseFilter.cjs');

const { decodeRisuSave, encodeRisuSaveLegacy, normalizeJSON } = require('./utils.cjs');
const { createLegacyRestoreService } = require('./dataRestore/index.cjs');

// Install process-level error handlers before any other init so early crashes get logged.
installProcessHandlers();

// Node.js version check
const [nodeMajor] = process.version.slice(1).split('.').map(Number);
if (nodeMajor < 24) {
    logger.warn(`[Server] Node.js ${process.version} is below the recommended version (v24.x). Consider upgrading for best compatibility.`);
}

// Configuration flags for patch-based sync
const enablePatchSync = true;

// In-memory database cache for patch-based sync
// dbCache stores the STRIPPED (stubs-only) version matching what the client sees.
// fullChatStore keeps the actual chat data keyed by chaId→chatId.
const storageState = {
    dbCache: {},
    fullChatStore: null,
    dbEtag: null,
    lastPersistFailure: null,
};
const saveTimers = {};

const MISSING_DATABASE_ETAG = '__missing_database__';
let restoreColdStorageCharactersInDb;
let restoreColdStorageChat;
let appDataMigration;
let appDataReadyPromise = null;

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

/**
 * Debounce a persist without opening a second writer lane. Once the timer
 * fires it joins the same storage queue as request writes and Revenant
 * materialization, so an older snapshot can never finish after a newer
 * canonical commit. Remove the timer token before queueing: a later debounce
 * must not be deleted by the older queued operation's cleanup.
 */

const DB_HEX_KEY = Buffer.from('database/database.bin', 'utf-8').toString('hex');

// ─── Persist failure tracking (Stage 1 visibility) ───────────────────────────
// Debounced persist runs in setTimeout, so failures cannot be returned in the
// triggering response. Record the latest failure here and surface it on the
// next /api/patch response. Cleared on next successful persist.

function clearPersistFailure() {
    storageState.lastPersistFailure = null;
}

function currentPersistWarning() {
    return storageState.lastPersistFailure;
}

// ─── Server-side database backup (DB-only snapshots) ────────────────────────
//
// Snapshots live as `database/dbbackup-{ts}.bin` keys inside the kv table.
// They're created on every successful persist (with a cooldown) and rotated
// to fit user-configured count/size limits — see SNAPSHOT_LIMIT_* below.
const SNAPSHOT_LIMIT_COUNT_KEY = 'config/snapshot-max-count';
const SNAPSHOT_LIMIT_BYTES_KEY = 'config/snapshot-max-bytes';
const SNAPSHOT_LIMIT_DEFAULT_COUNT = 20;
const SNAPSHOT_LIMIT_DEFAULT_BYTES = 500 * 1024 * 1024; // 500 MB
// Safety bounds to keep a stray PUT from making the system unusable.
const SNAPSHOT_LIMIT_MIN_COUNT = 1;
const SNAPSHOT_LIMIT_MAX_COUNT = 100;
const SNAPSHOT_LIMIT_MIN_BYTES = 10 * 1024 * 1024;        // 10 MB
const SNAPSHOT_LIMIT_MAX_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB
const BACKUP_INTERVAL_MS = process.env.POCKETRISU_BACKUP_INTERVAL_MS
    ? Number(process.env.POCKETRISU_BACKUP_INTERVAL_MS)
    : 5 * 60 * 1000; // 5 minutes (override for tests to force snapshot creation)
let lastBackupTime = null;
let backupRotationScheduled = false;
let backupWorker = null;

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

// Current snapshot count + two totals:
//   bytes        — physical union of all selected snapshot rows and unique
//                  content-addressed chunks, exactly matching quota trimming.
//   logicalBytes — sum of each snapshot's full logical size (kvSize), i.e. what
//                  the snapshots would cost WITHOUT dedup. Drives the "saved by
//                  deduplication" figure; never used for trimming.

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
    kvSetChunked(backupKey, Buffer.from(encodeRisuSaveLegacy(projection)));
    if (!kvGet(backupKey)) throw new Error('Cannot create snapshot: database blob is missing');
    bookmarkStore.saveSnapshot(backupKey);
    trimSnapshotsToLimits();
    return backupKey;
});

function createSnapshotNow() {
    return createSnapshotState();
}

function createBackupAndRotate() {
    const now = Date.now();
    if (lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS) {
        return;
    }
    lastBackupTime = now;

    createSnapshotNow();
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
        backupWorker = worker;
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
            if (backupWorker === worker) backupWorker = null;
            backupRotationScheduled = false;
        });
    });
}

async function flushPendingDb() {
    if (saveTimers[DB_HEX_KEY]) {
        clearTimeout(saveTimers[DB_HEX_KEY]);
        delete saveTimers[DB_HEX_KEY];
        await persistFullChatStoreNow();
        createBackupAndRotate();
    }
}

// ─── Chat runtime lazy load helpers ─────────────────────────────────────────

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
            if (!chat || chat._stub) continue;
            if (!chat.id || chatIds.has(chat.id)) {
                chat.id = nodeCrypto.randomUUID();
                changed = true;
            }
            chatIds.add(chat.id);
            if (!Array.isArray(chat.message)) continue;
            const messageIds = new Set();
            for (const message of chat.message) {
                if (!message) continue;
                if (!message.chatId || messageIds.has(message.chatId)) {
                    message.chatId = nodeCrypto.randomUUID();
                    changed = true;
                }
                messageIds.add(message.chatId);
            }
        }
    }
    return changed;
}

// Recovers chats whose folderId points to a deleted folder. The previous merge
// layer silently kept stale folderId on disk when a user moved a chat out of a
// folder, then later deleting that folder produced orphans invisible in the
// sidebar (rendered into neither the no-folder section nor any folder section).
// Boot-time normalize so historical corruption self-heals; new corruption is
// blocked by the merge fix in mergeChatStubWithFullChat.
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

function normalizeLegacyDatabaseProjection(dbObj) {
    const normalized = normalizeJSON(dbObj);
    assignMissingPersistentIds(normalized);
    normalizeOrphanFolderIds(normalized);

    const coldRestoreResult = restoreColdStorageCharactersInDb(normalized);
    if (Array.isArray(normalized?.characters)) {
        for (const character of normalized.characters) {
            for (const chat of Array.isArray(character?.chats) ? character.chats : []) {
                if (!restoreColdStorageChat(chat)) {
                    throw new Error(
                        `Cold storage chat restore failed for ${character?.chaId ?? 'unknown'}/${chat?.id ?? 'unknown'}`,
                    );
                }
            }
        }
    }
    return { database: normalized, coldRestoreResult };
}

function reassembleFullDb(strippedDb) {
    return reassembleFullDbFromStore(strippedDb, storageState.fullChatStore);
}

function isCloudflareTunnelRequest(req) {
    return isCloudflareTunnelRequestForUrl(req, tunnelState.tunnelUrl);
}

// Legacy REMOTE migration is provided by dataRestore/legacyRestore.cjs.

/** Ensure the requested chat is present in the process-local hot cache. */
async function ensureChatStore(characterId, chatId) {
    await ensureCanonicalStorage();
    if (!storageState.fullChatStore) storageState.fullChatStore = new Map();
    if (!appDataStore.getState().initialized || !characterId || !chatId) return;
    let chats = storageState.fullChatStore.get(characterId);
    if (chats?.has(chatId)) return;
    const chat = appDataStore.getChat(characterId, chatId);
    if (!chat) return;
    if (!chats) {
        chats = new Map();
        storageState.fullChatStore.set(characterId, chats);
    }
    chats.set(chatId, chat);
}

// Stub metadata fields a JSON Patch may legitimately touch on a `chats[i]`
// entry. Anything else is a chat-internal field — those live in fullChatStore,
// not in dbCache, and should never appear in a /api/patch payload. Keep in
// intentionally limited to metadata that is part of the lazy chat stub.
const STUB_METADATA_FIELDS = new Set(['id', 'name', '_stub', 'lastDate', 'folderId', 'modules']);

// Only add/replace/remove are produced by the legitimate patcher. move/copy
// could alias _stub or other chat-internal fields through `from`, bypassing
// the path-based field allowlist. Reject those op types outright on chat
// paths. test ops can also reveal/manipulate state; deny for symmetry.
const ALLOWED_CHAT_OP_TYPES = new Set(['add', 'replace', 'remove']);

const CHAT_FIELD_PATH_RE = /^\/characters\/\d+\/chats\/\d+\/([^/]+)/;

/**
 * Detect JSON Patch ops that mutate chat-internal fields (anything beyond
 * STUB_METADATA_FIELDS). Such ops are the loss vector: applying them to
 * dbCache leaves a metadata-only chat without `_stub`, which then bypasses
 * fullChat merge in reassembleFullDb and gets persisted as-is.
 *
 * Whole-chat ops (path = `/characters/N/chats/M` or `/characters/N/chats`)
 * are allowed — those replace/add/remove chat slots wholesale and the
 * reassemble guard takes care of validating the resulting state.
 *
 * The `_stub` field gets stricter treatment than other allowed fields: only
 * `add`/`replace` with literal value `true` is permitted. Any op that could
 * remove the flag or set it to a falsy value is itself the loss mechanism
 * (reassembleFullDb skips merge when `_stub` is falsy), so it must be
 * blocked at the patch boundary, not just at the persist boundary.
 *
 * `move`/`copy` ops are rejected wholesale on chat-internal paths because
 * the field-name allowlist on `path` alone can't catch a `from` that points
 * at `_stub` or another chat-internal field. Both `path` and `from` are
 * checked when present.
 */
function findChatInternalFieldOps(patch) {
    if (!Array.isArray(patch)) return [];
    const violations = [];
    for (const op of patch) {
        if (!op || typeof op !== 'object' || typeof op.path !== 'string') continue;

        const pathMatch = op.path.match(CHAT_FIELD_PATH_RE);
        const fromMatch = typeof op.from === 'string' ? op.from.match(CHAT_FIELD_PATH_RE) : null;
        if (!pathMatch && !fromMatch) continue;

        if (!ALLOWED_CHAT_OP_TYPES.has(op.op)) {
            violations.push({
                op: op.op,
                path: op.path,
                field: (pathMatch && pathMatch[1]) || (fromMatch && fromMatch[1]) || '',
                reason: 'disallowed op type on chat field',
            });
            continue;
        }

        if (pathMatch) {
            const field = pathMatch[1];
            if (!STUB_METADATA_FIELDS.has(field)) {
                violations.push({ op: op.op, path: op.path, field });
                continue;
            }
            if (field === '_stub') {
                if (op.op === 'remove') {
                    violations.push({ op: op.op, path: op.path, field, reason: 'remove _stub' });
                } else if ((op.op === 'add' || op.op === 'replace') && op.value !== true) {
                    violations.push({ op: op.op, path: op.path, field, reason: 'non-true _stub value' });
                }
            }
        }
    }
    return violations;
}

/**
 * Detect chats that lost their `_stub` flag without being upgraded to a real
 * Chat. reassembleFullDb skips merge when `_stub` is falsy, so persisting such
 * a chat would write metadata-only to disk and silently strip messages — the
 * exact data-loss path reported with PATCH `remove /chats/N/{message,...}` ops.
 *
 * A real Chat has `message` (Array). A real stub has `_stub === true`. Anything
 * with neither is a malformed in-between state; treat as a corruption signal.
 */
/**
 * Persist dbCache to disk with full chats merged back in.
 */

/** Persist the canonical full-chat store immediately, preserving pending stub edits. */
async function persistFullChatStoreNow() {
    await ensureChatStore();
    if (storageState.dbCache[DB_HEX_KEY]) {
        const fullDb = reassembleFullDb(storageState.dbCache[DB_HEX_KEY]);
        appDataStore.replaceFromProjection(fullDb, {
            expectedRevision: appDataStore.getState().revision,
        });
        refreshCanonicalDatabaseCache();
        return;
    }
    if (!storageState.fullChatStore || storageState.fullChatStore.size === 0) return;
    const stripped = appDataStore.exportProjection({ includeMessages: false });
    const fullDb = reassembleFullDb(stripped);
    appDataStore.replaceFromProjection(fullDb, {
        expectedRevision: appDataStore.getState().revision,
    });
    refreshCanonicalDatabaseCache();
}

/**
 * Persist generation-owned activity metadata together with the already
 * committed chat input. The storage queue serializes this with every other DB
 * mutation, so concurrent devices increment the server value instead of
 * racing client-side snapshots.
 */
async function persistCanonicalChatState({
    characterId,
    chatId,
    chat,
    generationInput = false,
    mutationPatch,
}) {
    await ensureCanonicalStorage();
    if (!appDataStore.getState().initialized) {
        throw new Error('Canonical relational database is missing');
    }
    const previousCachedDb = storageState.dbCache[DB_HEX_KEY]
        ?? appDataStore.exportProjection({ includeMessages: false });
    const nextDb = structuredClone(previousCachedDb);

    const metadata = generationInput
        ? applyGenerationInputMetadata(nextDb, characterId)
        : undefined;
    if (generationInput && !metadata) {
        const error = new Error('Generation input character not found');
        error.httpStatus = 404;
        throw error;
    }
    if (mutationPatch) {
        applyMutationPatch(nextDb, characterId, mutationPatch);
    }

    try {
        let committed;
        sqliteDb.transaction(() => {
            committed = appDataStore.commitChat(
                characterId,
                chatId,
                chat,
                undefined,
                { requireExpected: false },
            );
            appDataStore.syncStartupProjection(nextDb);
        })();
        storageState.dbCache[DB_HEX_KEY] = appDataStore.exportProjection({ includeMessages: false });
        storageState.dbEtag = computeDatabaseEtagFromObject(storageState.dbCache[DB_HEX_KEY]);
        clearPersistFailure();
        try {
            scheduleBackupAndRotate();
        } catch (error) {
            logger.warn('[CanonicalChat] Backup rotation failed:', error);
        }
        return { ...committed, metadata };
    } catch (error) {
        storageState.dbCache[DB_HEX_KEY] = previousCachedDb;
        throw error;
    }
}

async function scheduleCanonicalChatPersist({ characterId, chatId, chat }) {
    await ensureCanonicalStorage();
    const committed = appDataStore.commitChat(
        characterId,
        chatId,
        chat,
        undefined,
        { requireExpected: false },
    );
    // Creating a chat also changes the startup list. Keep legacy cache readers
    // and the database ETag aligned with the durable commit before publishing it.
    if (committed.projectionChanged) refreshCanonicalDatabaseCache();
    clearPersistFailure();
    try {
        scheduleBackupAndRotate();
    } catch (error) {
        logger.warn('[CanonicalChat] Backup rotation failed:', error);
    }
    return committed;
}

function shouldCompress(req, res) {
    // Proxy/hub-proxy: pass through external responses without compression.
    // Original upstream server has no compression middleware at all,
    // so proxy responses were never compressed in the first place.
    const url = req.originalUrl || req.url;
    if (url.startsWith('/proxy2') || url.startsWith('/hub-proxy') || url.startsWith('/api/backup/export') || url.startsWith('/api/backup/server/download/')) {
        return false;
    }

    const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
        return false;
    }
    // NDJSON endpoints (backup import/restore, inlay bulk compression) emit
    // small per-line events and rely on real-time flushes — keepalive
    // heartbeats in particular must reach reverse proxies before their
    // response timeout fires. gzip would buffer those lines until enough
    // bytes accumulated for an efficient compression block, defeating the
    // 502-avoidance the streaming endpoints were built for. compressible's
    // mime-db happens not to list application/x-ndjson today (so this is
    // a no-op in practice) but a future dep upgrade could flip it on.
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
// Vite 산출물은 해시 파일명이므로 /assets는 장기 캐시 안전
app.use('/assets', express.static(path.join(process.cwd(), 'dist/assets'), {
    maxAge: '1y',
    immutable: true,
}));
app.use(express.static(path.join(process.cwd(), 'dist'), {index: false, maxAge: 0}));

app.use(express.json({ limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));

const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');

const authState = {
    password: '',
};

// Ensure /save/ exists for password file and migration source
const savePath = path.join(process.cwd(), "save")
if(!existsSync(savePath)){
    mkdirSync(savePath)
}

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
        require('fs').writeFileSync(BACKUP_PATH_MARKER, absPath, 'utf-8');
    } catch {
        // Best-effort; marker absence only means the updater falls back to the
        // hard-coded `backups` keep — same as before this feature existed.
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

const passwordPath = path.join(process.cwd(), 'save', '__password')
if(existsSync(passwordPath)){
    authState.password = readFileSync(passwordPath, 'utf-8')
}

// ── NodeOnly: server-side JWT (HMAC-SHA256) ─────────────────────────────────
// Upstream uses client-side ECDSA JWT via crypto.subtle, which requires
// Secure Context (HTTPS or localhost). NodeOnly needs HTTP remote access,
// so we moved JWT signing/verification to the server using HMAC-SHA256.
// If upstream changes its auth flow, this section needs manual sync.
// Related: createServerJwt(), checkAuth(), /api/login, /api/token/refresh
const jwtSecretPath = path.join(savePath, '__jwt_secret')
let jwtSecret
if (existsSync(jwtSecretPath)) {
    jwtSecret = readFileSync(jwtSecretPath, 'utf-8').trim()
} else {
    jwtSecret = nodeCrypto.randomBytes(64).toString('hex')
    writeFileSync(jwtSecretPath, jwtSecret, 'utf-8')
}

// ── Instance ID for anonymous usage analytics ────────────────────────────────
const instanceIdPath = path.join(savePath, '__instance_id')
let instanceId
if (existsSync(instanceIdPath)) {
    instanceId = readFileSync(instanceIdPath, 'utf-8').trim()
} else {
    instanceId = nodeCrypto.randomUUID()
    writeFileSync(instanceIdPath, instanceId, 'utf-8')
}

const inlayDir = path.join(savePath, 'inlays')
const inlayVideoThumbnailDir = path.join(inlayDir, '.video-thumbnails')
const inlayMigrationMarker = path.join(inlayDir, '.migrated_to_fs')

// Minimum free disk space headroom multiplier: require 2× the backup size to be free

// Heartbeat interval for NDJSON import progress stream. 5 s by default —
// shorter than every common reverse-proxy response timeout (nginx 60 s, Cloudflare
// 100 s). Operators behind more aggressive proxies can tighten this. Clamped to
// 100 ms so a misconfiguration can't spam the socket.

// ── Cloudflare Quick Tunnel ─────────────────────────────────────────────────

const tunnelState = {
    tunnelProcess: null,
    tunnelUrl: null,
    tunnelStatus: 'off',
    tunnelError: null,
    tunnelStartTimeout: null,
    serverIsHttps: false,
};

   // 'off' | 'downloading' | 'starting' | 'running' | 'error'

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

// ── Update check ─────────────────────────────────────────────────────────────

// Re-read on each call so non-portable updates (docker/git pull) without a
// process restart don't keep reporting the old version to the update worker.

// ── Deployment type & self-update helpers ─────────────────────────────────────

function isSafeInlayId(id) {
    return typeof id === 'string' &&
        id.length > 0 &&
        !id.includes('\0') &&
        !id.includes('/') &&
        !id.includes('\\') &&
        id !== '.' &&
        id !== '..';
}

function normalizeInlayExt(ext) {
    if (typeof ext !== 'string') return 'bin';
    const normalized = ext.trim().toLowerCase().replace(/^\.+/, '').replace(/[\/\\\0]/g, '');
    return normalized || 'bin';
}

const resolvedInlayDir = path.resolve(inlayDir) + path.sep;

function assertInsideInlayDir(filePath) {
    if (!path.resolve(filePath).startsWith(resolvedInlayDir)) {
        throw new Error(`Path escapes inlay directory: ${filePath}`);
    }
}

function getInlayFilePath(id, ext) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayDir, `${id}.${normalizeInlayExt(ext)}`);
    assertInsideInlayDir(p);
    return p;
}

function getInlaySidecarPath(id) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayDir, `${id}.meta.json`);
    assertInsideInlayDir(p);
    return p;
}

function getInlayVideoThumbnailPath(id) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const filePath = path.join(inlayVideoThumbnailDir, `${id}.webp`);
    assertInsideInlayDir(filePath);
    return filePath;
}

async function deleteInlayVideoThumbnail(id) {
    await fs.unlink(getInlayVideoThumbnailPath(id)).catch(() => {});
}

function deleteInlayVideoThumbnailSync(id) {
    try {
        unlinkSync(getInlayVideoThumbnailPath(id));
    } catch {
        // ignore
    }
}

async function ensureInlayDir() {
    await fs.mkdir(inlayDir, { recursive: true });
}

function ensureInlayDirSync() {
    if (!existsSync(inlayDir)) {
        mkdirSync(inlayDir, { recursive: true });
    }
}

function getMimeFromExt(ext, buffer) {
    return ASSET_EXT_MIME[normalizeInlayExt(ext)] || detectMime(buffer);
}

function decodeDataUri(dataUri) {
    if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) {
        throw new Error('Invalid data URI');
    }
    const commaIdx = dataUri.indexOf(',');
    if (commaIdx === -1) {
        throw new Error('Malformed data URI');
    }
    const meta = dataUri.substring(5, commaIdx);
    return {
        buffer: Buffer.from(dataUri.substring(commaIdx + 1), 'base64'),
        mime: meta.split(';')[0] || 'application/octet-stream',
    };
}

async function readInlaySidecar(id) {
    try {
        const raw = await fs.readFile(getInlaySidecarPath(id), 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            ext: normalizeInlayExt(parsed?.ext),
            name: typeof parsed?.name === 'string' ? parsed.name : id,
            type: typeof parsed?.type === 'string' ? parsed.type : 'image',
            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
        };
    } catch {
        return null;
    }
}

async function resolveInlayFilePath(id) {
    if (!isSafeInlayId(id)) return null;
    const sidecar = await readInlaySidecar(id);
    if (sidecar) {
        const candidate = getInlayFilePath(id, sidecar.ext);
        try { await fs.access(candidate); return candidate; } catch {}
    }
    // Fallback: scan directory (covers pre-sidecar files or mismatched ext)
    try {
        const entries = await fs.readdir(inlayDir, { withFileTypes: true });
        const match = entries.find((entry) => (
            entry.isFile() &&
            entry.name.startsWith(`${id}.`) &&
            entry.name !== `${id}.meta.json`
        ));
        return match ? path.join(inlayDir, match.name) : null;
    } catch {
        return null;
    }
}

function resolveInlayFilePathSync(id) {
    if (!isSafeInlayId(id)) return null;
    try {
        const raw = readFileSync(getInlaySidecarPath(id), 'utf-8');
        const parsed = JSON.parse(raw);
        const ext = normalizeInlayExt(parsed?.ext);
        const candidate = getInlayFilePath(id, ext);
        if (existsSync(candidate)) return candidate;
    } catch {}
    // Fallback: scan directory
    try {
        const entries = readdirSync(inlayDir, { withFileTypes: true });
        const match = entries.find((entry) => (
            entry.isFile() &&
            entry.name.startsWith(`${id}.`) &&
            entry.name !== `${id}.meta.json`
        ));
        return match ? path.join(inlayDir, match.name) : null;
    } catch {
        return null;
    }
}

async function readInlayFile(id) {
    const info = await getInlayFileInfo(id);
    if (!info) return null;
    const buffer = await fs.readFile(info.filePath);
    return {
        ...info,
        buffer,
        mime: getMimeFromExt(info.ext, buffer),
    };
}

async function getInlayFileInfo(id) {
    const filePath = await resolveInlayFilePath(id);
    if (!filePath) return null;
    const ext = normalizeInlayExt(path.extname(filePath).slice(1));
    const stat = await fs.stat(filePath);
    return {
        ext,
        filePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
    };
}

async function writeInlaySidecar(id, info) {
    await ensureInlayDir();
    const sidecar = {
        ext: normalizeInlayExt(info?.ext),
        name: typeof info?.name === 'string' ? info.name : id,
        type: typeof info?.type === 'string' ? info.type : 'image',
        height: typeof info?.height === 'number' ? info.height : undefined,
        width: typeof info?.width === 'number' ? info.width : undefined,
    };
    await fs.writeFile(getInlaySidecarPath(id), JSON.stringify(sidecar));
}

function writeInlaySidecarSync(id, info) {
    ensureInlayDirSync();
    const sidecar = {
        ext: normalizeInlayExt(info?.ext),
        name: typeof info?.name === 'string' ? info.name : id,
        type: typeof info?.type === 'string' ? info.type : 'image',
        height: typeof info?.height === 'number' ? info.height : undefined,
        width: typeof info?.width === 'number' ? info.width : undefined,
    };
    writeFileSync(getInlaySidecarPath(id), JSON.stringify(sidecar));
}

async function writeInlayFile(id, ext, buffer, info = null) {
    await ensureInlayDir();
    await deleteInlayRawFile(id);
    await deleteInlayVideoThumbnail(id);
    const normalizedExt = normalizeInlayExt(ext);
    await fs.writeFile(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
    await writeInlaySidecar(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
}

function writeInlayFileSync(id, ext, buffer, info = null) {
    ensureInlayDirSync();
    deleteInlayRawFileSync(id);
    deleteInlayVideoThumbnailSync(id);
    const normalizedExt = normalizeInlayExt(ext);
    writeFileSync(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
    writeInlaySidecarSync(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
}

async function deleteInlayRawFile(id) {
    const filePath = await resolveInlayFilePath(id);
    if (!filePath) return;
    await fs.unlink(filePath).catch(() => {});
}

function deleteInlayRawFileSync(id) {
    const filePath = resolveInlayFilePathSync(id);
    if (!filePath) return;
    try {
        unlinkSync(filePath);
    } catch {
        // ignore
    }
}

function deleteInlayFileSync(id) {
    deleteInlayRawFileSync(id);
    deleteInlayVideoThumbnailSync(id);
    try {
        unlinkSync(getInlaySidecarPath(id));
    } catch {
        // ignore
    }
}

async function listInlayFiles() {
    await ensureInlayDir();
    const entries = await fs.readdir(inlayDir, { withFileTypes: true });
    return entries
        .filter((entry) => (
            entry.isFile() &&
            entry.name !== '.migrated_to_fs' &&
            !entry.name.endsWith('.meta.json')
        ))
        .map((entry) => {
            const ext = normalizeInlayExt(path.extname(entry.name).slice(1));
            const id = entry.name.slice(0, -(ext.length + 1));
            return { id, ext, filePath: path.join(inlayDir, entry.name) };
        })
        .filter((entry) => isSafeInlayId(entry.id));
}

async function readInlayLegacyInfo(id) {
    const value = kvGet(`inlay_info/${id}`);
    if (!value) return null;
    try {
        const parsed = JSON.parse(value.toString('utf-8'));
        return {
            ext: normalizeInlayExt(parsed?.ext),
            name: typeof parsed?.name === 'string' ? parsed.name : id,
            type: typeof parsed?.type === 'string' ? parsed.type : 'image',
            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
        };
    } catch {
        return null;
    }
}

async function readInlayInfoPayload(id) {
    const sidecar = await readInlaySidecar(id);
    if (sidecar) return Buffer.from(JSON.stringify(sidecar));
    const legacy = await readInlayLegacyInfo(id);
    if (legacy) return Buffer.from(JSON.stringify(legacy));
    return kvGet(`inlay_info/${id}`);
}

async function migrateInlaysToFilesystem() {
    await ensureInlayDir();
    if (existsSync(inlayMigrationMarker)) return;

    const keys = kvList('inlay/');
    for (const key of keys) {
        const id = key.slice('inlay/'.length);
        if (!isSafeInlayId(id)) continue;
        const fileAlreadyExists = await readInlayFile(id);
        if (fileAlreadyExists) {
            kvDel(key);
            kvDel(`inlay_thumb/${id}`);
            kvDel(`inlay_info/${id}`);
            continue;
        }
        const value = kvGet(key);
        if (!value) continue;
        try {
            const parsed = JSON.parse(value.toString('utf-8'));
            const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
            const ext = normalizeInlayExt(parsed?.ext);
            let buffer;
            if (type === 'signature') {
                buffer = Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8');
            } else {
                buffer = decodeDataUri(parsed?.data).buffer;
            }
            const info = (await readInlayLegacyInfo(id)) || {
                ext,
                name: typeof parsed?.name === 'string' ? parsed.name : id,
                type,
                height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                width: typeof parsed?.width === 'number' ? parsed.width : undefined,
            };
            await writeInlayFile(id, ext, buffer, info);
            kvDel(key);
            kvDel(`inlay_thumb/${id}`);
            kvDel(`inlay_info/${id}`);
        } catch (error) {
            logger.warn(`[InlayFS] Failed to migrate ${key}:`, error?.message || error);
        }
    }

    await fs.writeFile(inlayMigrationMarker, new Date().toISOString(), 'utf-8');
}

// ── Session store for direct asset URL auth (F-0) ──────────────────────────
// <img src="/api/asset/..."> cannot send custom headers, so we use a session
// cookie issued after initial JWT auth. Single-user environment: Map is fine.
// Sessions are persisted to disk so they survive server restarts.
const SESSION_FILE = path.join(process.cwd(), 'save', '__sessions')
const sessions = new Map() // token → expiresAt (ms)

function sessionExpiresAt(session) {
    return typeof session === 'number' ? session : session?.expiresAt ?? 0
}

function connectedDevice(userAgent = '') {
    if (/Windows/i.test(userAgent)) return { name: 'Windows', type: 'desktop' }
    if (/iPhone|iPad|iPod/i.test(userAgent)) return { name: 'iPhone/iPad', type: 'mobile' }
    if (/Android/i.test(userAgent)) return { name: 'Android', type: 'mobile' }
    if (/Macintosh|Mac OS X/i.test(userAgent)) return { name: 'macOS', type: 'desktop' }
    if (/Linux/i.test(userAgent)) return { name: 'Linux', type: 'desktop' }
    return { name: 'Unknown device', type: 'desktop' }
}

function loadSessions() {
    try {
        const raw = readFileSync(SESSION_FILE, 'utf-8')
        const now = Date.now()
        for (const [token, storedSession] of JSON.parse(raw)) {
            const expiresAt = sessionExpiresAt(storedSession)
            if (expiresAt > now) sessions.set(token, expiresAt)
        }
    } catch { /* file missing or corrupt – start fresh */ }
}

loadSessions()

function parseSessionCookie(req) {
    const cookieHeader = req.headers.cookie || ''
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=')
        if (eq === -1) continue
        if (part.slice(0, eq).trim() === 'risu-session') return part.slice(eq + 1).trim()
    }
    return null
}

function sessionAuthMiddleware(req, res, next) {
    const token = parseSessionCookie(req)
    if (token && sessionExpiresAt(sessions.get(token)) > Date.now()) return next()
    res.status(401).end()
}

// MIME detection by magic bytes (fallback when key has no extension)
function detectMime(buf) {
    if (!buf || buf.length < 12) return 'application/octet-stream'
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
    if (buf[0] === 0x1a && buf[1] === 0x45) return 'video/webm'
    if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4'
    return 'application/octet-stream'
}
const ASSET_EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    m4v: 'video/x-m4v', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
}

// Each page has an opaque client id. It is not a write lock: this is a
// single-user server, so every authenticated page may submit mutations. The id
// is retained to suppress self-echoes on the sync WebSocket.

function getSyncClientIdFromRequest(req) {
    return req?.headers?.['x-sync-client-id'] || req?.headers?.['x-session-id'] || ''
}

function requireSyncClientId(req, res) {
    if (!getSyncClientIdFromRequest(req)) {
        res.status(400).json({ error: 'Sync client id required' })
        return false
    }
    return true
}

const syncClients = new Map();
const syncClientDevices = new Map();

function isSyncClientConnected(clientId) {
    return Boolean(clientId && syncClients.get(clientId)?.size);
}

function broadcastSync(type, payload = {}, excludeClientId = null) {
    const message = JSON.stringify({ type, ...payload });
    for (const [clientId, clients] of syncClients) {
        if (clientId === excludeClientId) continue;
        for (const ws of clients) {
            if (ws.readyState === 1) ws.send(message);
        }
    }
}

function broadcastDatabaseInvalidated(req, payload = {}) {
    broadcastSync(
        'database-invalidated',
        { ...payload, timestamp: Date.now(), etag: storageState.dbEtag ?? undefined },
        String(getSyncClientIdFromRequest(req)),
    );
}

function broadcastBookmarksInvalidated(req) {
    broadcastSync(
        'bookmarks-invalidated',
        { timestamp: Date.now() },
        String(getSyncClientIdFromRequest(req)),
    );
}

function publishChatCommitted(event, originClientId) {
    broadcastSync('database-invalidated', {
        chats: [{ characterId: event.characterId, chatId: event.chatId }],
        etag: storageState.dbEtag ?? undefined,
        chatEtag: event.etag,
        reason: event.reason,
        timestamp: Date.now(),
    }, originClientId || null);
}

function broadcastRevenantWorkflowUpdated(workflow) {
    if (!workflow?.workflowId || !workflow.characterId || !workflow.roomId) return;
    broadcastSync('generation-workflow-updated', {
        workflowId: workflow.workflowId,
        characterId: workflow.characterId,
        roomId: workflow.roomId,
        status: workflow.status,
        timestamp: Date.now(),
    });
}

// --- Generation Job constants ---
const GENERATION_JOB_DEFAULT_TIMEOUT_MS = GENERATION_REQUEST_DEFAULT_TIMEOUT_MS;
const GENERATION_JOB_DEFAULT_HEARTBEAT_SEC = 15;
const GENERATION_JOB_HEARTBEAT_MIN_SEC = 5;
const GENERATION_JOB_HEARTBEAT_MAX_SEC = 60;
const GENERATION_JOB_GC_INTERVAL_MS = 60000;
const GENERATION_JOB_DONE_GRACE_MS = 30000;
const GENERATION_JOB_MAX_ACTIVE_JOBS = 64;
const generationRuntimeJobs = new Map();

function countActiveGenerationJobs() {
    return Array.from(generationRuntimeJobs.values())
        .filter(job => !job.done && !job.waitingDispatch)
        .length;
}

const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;

const loginBlockedUntil = new Map();

const loginBlockCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, blockedUntil] of loginBlockedUntil) {
        if (blockedUntil <= now) loginBlockedUntil.delete(key);
    }
}, LOGIN_FAILURE_WINDOW_MS);
loginBlockCleanupTimer.unref?.();

async function hashJSON(json){
    const hash = nodeCrypto.createHash('sha256');
    hash.update(JSON.stringify(json));
    return hash.digest('hex');
}

// NodeOnly: server-issued JWT (see jwt_secret comment above)

// --- Generation: auth helpers ---

function normalizeAuthHeader(authHeader) {
    if (Array.isArray(authHeader)) {
        return authHeader[0] || '';
    }
    return typeof authHeader === 'string' ? authHeader : '';
}

async function isAuthorizedProxyRequest(req) {
    return await checkAuth(req, null, true);
}

async function checkProxyAuth(req, res) {
    return await checkAuth(req, res);
}

function sanitizeGenerationTargetUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return null;
    }
}

// --- Generation: request/response helpers ---

function normalizeForwardHeaders(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof key !== 'string') continue;
        if (typeof value === 'string') {
            normalized[key] = value;
        }
    }
    delete normalized['risu-auth'];
    delete normalized['risu-timeout-ms'];
    delete normalized['host'];
    delete normalized['connection'];
    delete normalized['content-length'];
    return normalized;
}

function normalizeGenerationJobTimeoutMs(timeoutMs) {
    return normalizeGenerationRequestTimeoutMs(timeoutMs);
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
    const timeoutMs = normalizeGenerationJobTimeoutMs(Number(arg.timeoutMs));
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
        timeoutMs: GENERATION_JOB_DEFAULT_TIMEOUT_MS,
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
    maxActiveJobs: GENERATION_JOB_MAX_ACTIVE_JOBS,
    countActiveGenerationJobs,
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
    ensureChatStore,
    getChat: (characterId, chatId) => storageState.fullChatStore.get(characterId)?.get(chatId),
    replaceChat: (characterId, chatId, chat) => {
        let chats = storageState.fullChatStore.get(characterId);
        if (!chats && chat) {
            chats = new Map();
            storageState.fullChatStore.set(characterId, chats);
        }
        if (!chats) return;
        if (chat) chats.set(chatId, chat);
        else {
            chats.delete(chatId);
            if (chats.size === 0) storageState.fullChatStore.delete(characterId);
        }
    },
    commitChatContent: (characterId, chatId, chat, expectedEtag, options) =>
        commitChatContent(storageState.fullChatStore, characterId, chatId, chat, expectedEtag, options),
    computeChatEtag,
    getActiveGenerationWorkflow,
    getLatestGenerationWorkflow: generationDb.getLatestGenerationWorkflow,
    persistNow: persistCanonicalChatState,
    schedulePersist: scheduleCanonicalChatPersist,
    publishChatCommitted,
});
const imageGenerationJobService = createImageGenerationJobService({ logger });

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

async function executeServerImageAction({ workflow, action, projection = false }) {
    const payload = action?.payload || {};
    const target = payload.target || (workflow.context?.kind === 'image-generation'
        ? workflow.context.target
        : {
            characterId: workflow.context?.postprocess?.character?.chaId,
            roomId: workflow.context?.postprocess?.chat?.id,
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
    const requestPrompt = provider === 'novelai'
        ? String(payload.prompt || '')
            .replaceAll('\\(', '♧').replaceAll('\\)', '♤')
            .replaceAll('(', '{').replaceAll(')', '}')
            .replaceAll('♧', '(').replaceAll('♤', ')')
        : String(payload.prompt || '');
    const generated = await imageGenerationJobService.executeImageGeneration({
        jobId,
        settings: provider === 'comfyui' ? {
            sdProvider: 'comfyui',
            comfyConfig: { timeout: config.settings.comfyConfig?.timeout },
        } : config.settings,
        apiKey: config.apiKey,
        prompt: requestPrompt,
        negativePrompt: String(payload.negativePrompt || ''),
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
        imageGeneration: {
            prompt: String(payload.prompt || ''),
            negativePrompt: String(payload.negativePrompt || ''),
            seed,
        },
    })));
    const reference = `{{inlayed::${inlayId}}}`;
    if (projection) {
        await canonicalChatService.commitServerMutation({
            characterId: target.characterId,
            chatId: target.roomId,
            reason: 'image-generation-result',
            mutate: chat => {
                const messageId = String(payload.messageId || '');
                if (payload.projection === 'reroll') {
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
            const result = await executeServerImageAction({ workflow, action, projection: true });
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
        };
        const upstreamResponse = arg.adapterKind === 'echo'
            ? await executeEchoProviderRequest(providerRequest)
            : await executeUpstreamRequest(providerRequest);
        const filteredHeaders = upstreamResponse.headers;

        setGenerationJobHeaders(job.id, upstreamResponse.status, filteredHeaders);
        job.responseStatus = upstreamResponse.status;
        job.responseHeaders = filteredHeaders;
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
                        const writable = journalWriter.write(bytes, () => {
                            notifyRevenantJournalWaiters(job);
                        });
                        if (!writable) {
                            await new Promise((resolve, reject) => {
                                const cleanup = () => {
                                    journalWriter.off('drain', onDrain);
                                    journalWriter.off('error', onError);
                                };
                                const onDrain = () => {
                                    cleanup();
                                    resolve();
                                };
                                const onError = (error) => {
                                    cleanup();
                                    reject(error);
                                };
                                journalWriter.once('drain', onDrain);
                                journalWriter.once('error', onError);
                            });
                        }
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
        if (cancelled || (upstreamResponse.status >= 200 && upstreamResponse.status < 300)) {
            try {
                projection = await projectGenerationJournal(persisted, rawResponse);
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
        } else {
            if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
                terminalFailure = {
                    finishReason: 'upstream_http_error',
                    message: `Provider request failed with HTTP ${upstreamResponse.status}`,
                };
            }
        }
        updateRequestLogResponseById(
            job.id,
            rawResponse.toString('utf-8'),
            upstreamResponse.status,
            upstreamResponse.status >= 200 && upstreamResponse.status < 400,
            providerCompletedAt,
        );
        recordGenerationUsage({
            jobId: job.id,
            timestamp: persisted?.createdAt,
            chatId: persisted?.chatId,
            targetUrl,
            body: arg.body,
            rawResponse,
            outputText: projection?.content,
            usageProviderId: arg.usageProviderId,
            usageModelId: arg.usageModelId,
            usageServiceTier: arg.usageServiceTier,
        });
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
                cancelled ? cancelFinishReason : (providerCompleted ? 'provider_complete' : 'upstream_complete'),
                null,
                rawResponse.length,
            );
        }
        // A non-2xx upstream response is still a complete HTTP response. Close
        // its journal normally so the client adapter can read the provider's
        // error body and surface the precise message instead of a transport
        // level "HTTP N" fallback. The job remains failed in durable storage.
        if (terminalFailure?.finishReason === 'upstream_http_error') {
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
                finishReason: cancelled ? cancelFinishReason : (providerCompleted ? 'provider_complete' : 'upstream_complete'),
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
        let cancelFinishReason = 'user_cancelled';
        const persistedWithRaw = getGenerationJob(job.id, false);
        const rawResponse = readGenerationJobRaw(job.id);
        updateRequestLogResponseById(
            job.id,
            rawResponse.length > 0 ? rawResponse.toString('utf-8') : message,
            persistedWithRaw?.responseStatus,
            false,
        );
        recordGenerationUsage({
            jobId: job.id,
            timestamp: persistedWithRaw?.createdAt,
            chatId: persistedWithRaw?.chatId,
            targetUrl,
            body: arg.body,
            rawResponse,
            outputText: persistedWithRaw?.projection?.content,
            usageProviderId: arg.usageProviderId,
            usageModelId: arg.usageModelId,
            usageServiceTier: arg.usageServiceTier,
        });
        const hasPartial = rawResponse.length > 0;
        cancelFinishReason = persistedWithRaw?.finishReason || cancelFinishReason;
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
            const reqUrl = new URL(req.url, `http://${req.headers.host}`);
            if (reqUrl.pathname === '/sync') {
                const auth = reqUrl.searchParams.get('risu-auth') || normalizeAuthHeader(req.headers['risu-auth']);
                const clientId = reqUrl.searchParams.get('client-id');
                if (!clientId || !await isAuthorizedProxyRequest({ headers: { 'risu-auth': auth } })) {
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

            const auth = reqUrl.searchParams.get('risu-auth') || normalizeAuthHeader(req.headers['risu-auth']);
            if (!await isAuthorizedProxyRequest({ headers: { 'risu-auth': auth } })) {
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

    syncWsServer.on('connection', (ws, req, clientId) => {
        const clients = syncClients.get(clientId) ?? new Set();
        clients.add(ws);
        syncClients.set(clientId, clients);
        if (!syncClientDevices.has(clientId)) {
            syncClientDevices.set(clientId, {
                connectedAt: Date.now(),
                device: connectedDevice(req.headers['user-agent'] || ''),
            });
        }
        ws.send(JSON.stringify({ type: 'sync-ready', timestamp: Date.now() }));

        const pingTimer = setInterval(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }, 30_000);

        ws.on('close', () => {
            clearInterval(pingTimer);
            const current = syncClients.get(clientId);
            if (!current) return;
            current.delete(ws);
            if (current.size === 0) {
                syncClients.delete(clientId);
                syncClientDevices.delete(clientId);
            }
        });
        ws.on('error', () => clearInterval(pingTimer));
    });

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

// Legacy storage codecs and migrations are provided by dataRestore/legacyRestore.cjs.

/**
 * Decode an external database.bin projection, then return a synchronous
 * installer for the caller's outer SQLite transaction. Cold-storage references
 * are resolved during install, after staged coldstorage/ rows join it.
 */

const {
    normalizeColdStorageStorageKey,
    parseColdStorageJsonBuffer,
    encodeColdStorageCanonicalBuffer,
    readColdStorageJsonEntry,
    listColdStorageBackupEntries,
    restoreColdStorageCharactersInDb: restoreColdStorageCharacters,
    restoreColdStorageChat: restoreColdChat,
} = createLegacyRestoreService({
    sqliteDb,
    kvGet,
    kvSet,
    kvDel,
    logger,
});
restoreColdStorageCharactersInDb = restoreColdStorageCharacters;
restoreColdStorageChat = restoreColdChat;

appDataMigration = createAppDataMigration({
    db: sqliteDb,
    appDataStore,
    kv: {
        get: kvGet,
        delete: kvDel,
    },
    decodeLegacyBlob: async raw => {
        const decoded = await decodeRisuSave(raw);
        return normalizeLegacyDatabaseProjection(decoded).database;
    },
    normalizeProjection: normalizeJSON,
});

function reconcileCachedChats(startup) {
    if (!storageState.fullChatStore) return;
    const characters = new Map(
        (startup.characters ?? []).map(character => [character?.chaId, character]),
    );
    for (const [characterId, chats] of storageState.fullChatStore) {
        const character = characters.get(characterId);
        if (!character) {
            storageState.fullChatStore.delete(characterId);
            continue;
        }
        const stubs = new Map(
            (character.chats ?? []).map(stub => [stub?.id, stub]),
        );
        for (const [chatId, chat] of chats) {
            const stub = stubs.get(chatId);
            if (stub) chats.set(chatId, mergeChatStubWithFullChat(stub, chat));
            else chats.delete(chatId);
        }
        if (chats.size === 0) storageState.fullChatStore.delete(characterId);
    }
}

function refreshCanonicalDatabaseCache(options = {}) {
    const state = appDataStore.getState();
    if (!state.initialized) {
        delete storageState.dbCache[DB_HEX_KEY];
        storageState.fullChatStore = null;
        storageState.dbEtag = MISSING_DATABASE_ETAG;
        return;
    }
    const startup = appDataStore.exportProjection({ includeMessages: false });
    storageState.dbCache[DB_HEX_KEY] = startup;
    if (options.invalidateChats) storageState.fullChatStore = null;
    else reconcileCachedChats(startup);
    storageState.dbEtag = computeDatabaseEtagFromObject(startup);
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

        if (appDataStore.getState().initialized && bookmarkStore.needsLegacyMigration()) {
            // Bookmarks already have a canonical relational store. Ingest the
            // compatibility fields once, then remove them from chat payloads.
            const fullProjection = appDataStore.exportProjection({ includeMessages: true });
            const bookmarkMigration = bookmarkStore.migrateLegacyDatabase(fullProjection);
            if (bookmarkMigration.changed) {
                appDataStore.replaceFromProjection(fullProjection, {
                    expectedRevision: appDataStore.getState().revision,
                });
            }
        }
        refreshCanonicalDatabaseCache({ invalidateChats: true });
    })().catch(error => {
        appDataReadyPromise = null;
        throw error;
    });
    return appDataReadyPromise;
}

async function checkAuth(req, res, returnOnlyStatus = false, {allowExpired = false} = {}){
    try {
        const authHeader = req.headers['risu-auth'];

        if(!authHeader){
            if(!returnOnlyStatus){
                console.log('No auth header')
            }
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'No auth header'
            });
            return false
        }

        //jwt token
        const [
            jsonHeaderB64,
            jsonPayloadB64,
            signatureB64,
        ] = authHeader.split('.');

        //alg, typ
        const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, 'base64url').toString('utf-8'));

        //iat, exp
        const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, 'base64url').toString('utf-8'));

        //check expiration
        if(!allowExpired){
            const now = Math.floor(Date.now() / 1000);
            if(jsonPayload.exp < now){
                console.log('Token expired')
                if(returnOnlyStatus){
                    return false;
                }
                res.status(400).send({
                    error:'Token Expired'
                });
                return false
            }
        }

        //check signature (HMAC-SHA256)
        if(jsonHeader.alg !== "HS256"){
            console.log('Unsupported algorithm')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unsupported Algorithm'
            });
            return false
        }

        const expectedSig = nodeCrypto.createHmac('sha256', jwtSecret)
            .update(`${jsonHeaderB64}.${jsonPayloadB64}`)
            .digest()
        const actualSig = Buffer.from(signatureB64, 'base64url')

        if(expectedSig.length !== actualSig.length || !nodeCrypto.timingSafeEqual(expectedSig, actualSig)){
            console.log('Invalid signature')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Invalid Signature'
            });
            return false
        }
        return true
    } catch (error) {
        console.log(error)
        if(returnOnlyStatus){
            return false;
        }
        res.status(500).send({
            error:'Internal Server Error'
        });
        return false
    }
}

// --- Revenant generation jobs -------------------------------------------------
async function commitRevenantWorkflowInput({ characterId, roomId, input }) {
    return canonicalChatService.commitGenerationInput({
        characterId,
        chatId: roomId,
        chat: input.chat,
        expectedEtag: input.expectedEtag,
    });
}



/**
 * Extract raw binary and content-type from a KV value.
 * Handles both raw binary (assets/) and JSON+base64 wrapped (inlay/) formats.
 */
function resolveAssetPayload(key, rawValue) {
    // inlay/ and inlay_thumb/ keys store JSON with base64 data URI
    if (key.startsWith('inlay/') || key.startsWith('inlay_thumb/')) {
        try {
            const json = JSON.parse(rawValue.toString('utf-8'))
            const dataUri = json.data
            if (typeof dataUri === 'string' && dataUri.startsWith('data:')) {
                // Parse "data:<mime>;base64,<payload>"
                const commaIdx = dataUri.indexOf(',')
                const meta = dataUri.substring(5, commaIdx) // after "data:"
                const mime = meta.split(';')[0]
                const binary = Buffer.from(dataUri.substring(commaIdx + 1), 'base64')
                return { binary, contentType: mime || 'application/octet-stream' }
            }
            // Fallback: ext field
            const ext = (json.ext || '').toLowerCase()
            const mime = ASSET_EXT_MIME[ext] || 'application/octet-stream'
            return { binary: rawValue, contentType: mime }
        } catch {
            // JSON parse failed — treat as raw binary
        }
    }

    // assets/* and others: raw binary
    const ext = key.split('.').pop()?.toLowerCase()
    const contentType = ASSET_EXT_MIME[ext] || detectMime(rawValue)
    return { binary: rawValue, contentType }
}

const DB_BACKUP_PREFIX = 'database/dbbackup-';

// Sum the on-disk inlay payload (image files + sidecar JSONs in save/inlays).
// Returns 0 if the directory is missing. Used by both the backup-size
// estimator and the dashboard inlay total — kv inlay/* prefixes don't
// reflect filesystem bytes after the inlay→fs migration.
async function sumInlayFsBytes() {
    let total = 0;
    try {
        const inlayFiles = await listInlayFiles();
        await Promise.all(inlayFiles.map(async (entry) => {
            try {
                const st = await fs.stat(entry.filePath);
                total += st.size;
            } catch { /* missing — skip */ }
            try {
                const sst = await fs.stat(getInlaySidecarPath(entry.id));
                total += sst.size;
            } catch { /* sidecar may not exist */ }
        }));
    } catch { /* dir missing */ }
    return total;
}

// Estimated server-backup size — mirrors the enumeration in
// /api/backup/server/save without writing anything. Inlay files live on the
// filesystem (post-migration), so we have to fs.stat them rather than read
// kvSize. Cost: ~5-50 ms typical, ~200 ms for users with thousands of inlays.
async function estimateServerBackupSize(dbBytesOverride = null, inlayBytesOverride = null) {
    let total = 0;
    if (typeof dbBytesOverride === 'number') {
        total += dbBytesOverride;
    } else {
        total += appDataStore.getState().initialized
            ? appDataStore.estimateProjectionBytes()
            : 0;
    }
    for (const it of kvListWithSizes('assets/')) total += it.size;
    for (const it of kvListWithSizes('inlay_meta/')) total += it.size;
    for (const e of listColdStorageBackupEntries()) total += e.size;
    total += typeof inlayBytesOverride === 'number'
        ? inlayBytesOverride
        : await sumInlayFsBytes();
    return total;
}

const INLAY_IMAGE_SIZE_PIXELS = Object.freeze({
    '1k': 1024 * 1024,
    '2k': 2048 * 2048,
    '4k': 4096 * 4096,
    'original': Number.POSITIVE_INFINITY,
});
const INLAY_WEBP_EFFORT = 5;

function normalizeInlayImageSettings(input) {
    const size = Object.hasOwn(INLAY_IMAGE_SIZE_PIXELS, input?.size) ? input.size : '1k';
    const format = input?.format === 'png' ? 'png' : 'webp';
    const lossy = input?.lossy !== false;
    const rawQuality = Number(input?.quality);
    const quality = Number.isFinite(rawQuality)
        ? Math.min(1, Math.max(0.01, rawQuality > 1 ? rawQuality / 100 : rawQuality))
        : 0.85;
    return { size, format, lossy, quality };
}

async function encodeInlayImageBuffer(buffer, settings) {
    const vips = await getVips();
    const source = vips.Image.newFromBuffer(buffer);
    let rotated = null;
    let image = null;
    try {
        rotated = source.autorot();
        const maxPixels = INLAY_IMAGE_SIZE_PIXELS[settings.size];
        const currentPixels = rotated.width * rotated.height;
        const scale = currentPixels > maxPixels ? Math.sqrt(maxPixels / currentPixels) : 1;
        image = scale < 1
            ? rotated.resize(scale, { kernel: vips.Kernel.lanczos3 })
            : rotated;

        const output = settings.format === 'png'
            ? image.writeToBuffer('.png', { Q: 100 })
            : image.writeToBuffer('.webp', settings.lossy
                ? { Q: Math.round(settings.quality * 100), effort: INLAY_WEBP_EFFORT }
                : { lossless: true, effort: INLAY_WEBP_EFFORT });

        return {
            buffer: Buffer.from(output),
            ext: settings.format,
            width: image.width,
            height: image.height,
        };
    } finally {
        if (image && image !== rotated) image.delete();
        if (rotated) rotated.delete();
        source.delete();
    }
}

installImageGenerationJobRoutes(app, {
    checkProxyAuth, requireSyncClientId, service: imageGenerationJobService,
});

installRevenantGenerationRoutes(app, {
    checkProxyAuth,
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
    countActiveGenerationJobs,
    maxActiveJobs: GENERATION_JOB_MAX_ACTIVE_JOBS,
    randomUUID: () => nodeCrypto.randomUUID(),
    addRequestLog,
    materializeGeneration: revenantMaterializer.materialize,
});

require('./routes/web.cjs').installWebRoutes(app, {
    enablePatchSync,
});

require('./routes/proxy.cjs').installProxyRoutes(app, {
    checkAuth,
    isCloudflareTunnelRequest,
});

require('./routes/auth.cjs').installAuthRoutes(app, {
    SESSION_FILE,
    sessions,
    loginBlockedUntil,
    LOGIN_FAILURE_WINDOW_MS,
    jwtSecret,
    authState,
    checkAuth,
    parseSessionCookie,
    sessionExpiresAt,
    getSyncClientIdFromRequest,
    syncClientDevices,
    passwordPath,
});

require('./routes/assets/index.cjs').installAssetRoutes(app, {
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
});

require('./routes/database.cjs').installDatabaseRoutes(app, {
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
});

require('./routes/logs.cjs').installLogsRoutes(app, {
    checkAuth,
    requireSyncClientId,
});

require('./routes/backup.cjs').installBackupRoutes(app, {
    deleteSnapshotStateRows,
    DB_BACKUP_PREFIX,
    storageState,
    DB_HEX_KEY,
    saveTimers,
    backupState,
    BACKUP_FILENAME_REGEX,
    normalizeLegacyDatabaseProjection,
    bookmarkStore,
    appDataStore,
    createBackupAndRotate,
    savePath,
    inlayDir,
    inlayMigrationMarker,
    flushPendingDb,
    normalizeInlayExt,
    isSafeInlayId,
    decodeDataUri,
    ensureInlayDir,
    normalizeColdStorageStorageKey,
    parseColdStorageJsonBuffer,
    encodeColdStorageCanonicalBuffer,
    ensureCanonicalStorage,
    checkAuth,
    listInlayFiles,
    getInlaySidecarPath,
    listColdStorageBackupEntries,
    requireSyncClientId,
    queueStorageOperation,
    broadcastDatabaseInvalidated,
    broadcastBookmarksInvalidated,
    estimateServerBackupSize,
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
    refreshCanonicalDatabaseCache,
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
    ensureChatStore,
    storageState,
    broadcastBookmarksInvalidated,
});

require('./routes/chats.cjs').installChatsRoutes(app, {
    checkAuth,
    ensureCanonicalStorage,
    isCloudflareTunnelRequest,
    appDataStore,
    ensureChatStore,
    storageState,
    restoreColdStorageChat,
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
    estimateServerBackupSize,
    appDataStore,
    storageState,
    DB_BACKUP_PREFIX,
    BACKUP_FILENAME_REGEX,
    DB_HEX_KEY,
    requireSyncClientId,
    queueStorageOperation,
    flushPendingDb,
});

require('./routes/inlays.cjs').installInlaysRoutes(app, {
    sessionAuthMiddleware,
    requireSyncClientId,
    normalizeInlayImageSettings,
    encodeInlayImageBuffer,
    listInlayFiles,
    readInlaySidecar,
    writeInlayFile,
});

require('./routes/system.cjs').installSystemRoutes(app, {
    instanceId,
    checkAuth,
    stopTunnel,
    flushPendingDb,
});

require('./routes/tunnel.cjs').installTunnelRoutes(app, {
    checkAuth,
    tunnelState,
    stopTunnel,
});

// ─── Express error middleware — must be registered after all routes ─────────
app.use(expressErrorMiddleware);
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const unsupportedRemote = err?.code === 'UNSUPPORTED_REMOTE_SAVE';
    res.status(unsupportedRemote ? 400 : 500).json({
        error: err?.message || 'internal server error',
        ...(err?.code ? { code: err.code } : {}),
    });
});

// ─────────────────────────────────────────────────────────────────────────────

async function getHttpsOptions() {

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
        let server;

        if (httpsOptions) {
            // HTTPS
            tunnelState.serverIsHttps = true;
            server = https.createServer(httpsOptions, app);
            setupGenerationWebSocket(server);
            server.listen(port, () => {
                console.log("[Server] HTTPS server is running.");
                console.log(`[Server] https://localhost:${port}/`);
            });
        } else {
            // HTTP
            server = http.createServer(app);
            setupGenerationWebSocket(server);
            server.listen(port, () => {
                console.log("[Server] HTTP server is running.");
                console.log(`[Server] http://localhost:${port}/`);
            });
        }
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
            const projection = await projectGenerationJournal(job, rawResponse);
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

// Graceful shutdown: flush pending patches and checkpoint WAL before exit
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
        console.log(`[Server] Received ${sig}, flushing pending data...`);
        stopTunnel();
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
        try { await flushPendingDb(); } catch (e) { logger.error('[Server] Flush error:', e); }
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
                && now - job.updatedAt > Math.max(GENERATION_JOB_DEFAULT_TIMEOUT_MS, job.timeoutMs * 2)) {
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
    }, 5 * 60 * 1000); // every 5 minutes

    // Terminal recovery data is temporary. Keep it for one day, then remove DB
    // metadata and its journal even if no client reconnects.
    setInterval(() => {
        try { pruneRetainedGenerationJobs(); }
        catch (error) { logger.error('[GenerationJob] Retention cleanup failed:', error); }
    }, 60 * 60 * 1000);

})();

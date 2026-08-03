'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { generationJournalStore } = require('./generationJournal.cjs');

const MATERIALIZED_RETENTION_MS = 24 * 60 * 60 * 1000;

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}

const revenantDir = path.join(saveDir, 'revenant');
fs.mkdirSync(revenantDir, { recursive: true });
const legacyDbPath = path.join(saveDir, 'revenant-generation.db');
const dbPath = path.join(revenantDir, 'revenant.db');
if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
    const legacyDb = new Database(legacyDbPath);
    legacyDb.pragma('wal_checkpoint(TRUNCATE)');
    legacyDb.close();
    fs.renameSync(legacyDbPath, dbPath);
}
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('busy_timeout = 5000');
db.pragma('journal_size_limit = 67108864');

db.exec(`
    CREATE TABLE IF NOT EXISTS generation_jobs (
        job_id TEXT PRIMARY KEY,
        chat_id TEXT,
        job_type TEXT NOT NULL DEFAULT 'model',
        character_id TEXT,
        room_id TEXT,
        is_continuation INTEGER NOT NULL DEFAULT 0,
        continuation_prefix TEXT,
        generation_info TEXT,
        prompt_info TEXT,
        reroll_snapshot TEXT,
        operation_context TEXT,
        adapter_kind TEXT,
        streaming INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        response_status INTEGER,
        response_headers TEXT,
        raw_bytes INTEGER NOT NULL DEFAULT 0,
        raw_content TEXT NOT NULL DEFAULT '',
        finish_reason TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        materialized_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_chat
        ON generation_jobs(chat_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_materialized
        ON generation_jobs(materialized_at, updated_at DESC);
`);
db.exec(`DROP INDEX IF EXISTS idx_generation_jobs_pending`);

const generationColumns = new Set(
    db.prepare(`PRAGMA table_info(generation_jobs)`).all().map(column => column.name)
);
if (!generationColumns.has('raw_content')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN raw_content TEXT NOT NULL DEFAULT ''`);
}
if (!generationColumns.has('job_type')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'model'`);
}
if (!generationColumns.has('is_continuation')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN is_continuation INTEGER NOT NULL DEFAULT 0`);
}
if (!generationColumns.has('continuation_prefix')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN continuation_prefix TEXT`);
}
if (!generationColumns.has('generation_info')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN generation_info TEXT`);
}
if (!generationColumns.has('prompt_info')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN prompt_info TEXT`);
}
if (!generationColumns.has('reroll_snapshot')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN reroll_snapshot TEXT`);
}
if (!generationColumns.has('operation_context')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN operation_context TEXT`);
}
if (!generationColumns.has('adapter_kind')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN adapter_kind TEXT`);
}
if (!generationColumns.has('streaming')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN streaming INTEGER NOT NULL DEFAULT 0`);
}
if (!generationColumns.has('raw_bytes')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN raw_bytes INTEGER NOT NULL DEFAULT 0`);
}
// raw_response was used by the experimental SQLite-BLOB journal. Journals are
// now append-only files; do not keep two recovery sources alive indefinitely.
if (generationColumns.has('raw_response')) {
    db.exec(`UPDATE generation_jobs SET raw_response = X'' WHERE length(raw_response) > 0`);
}
// Older test builds cached client-side output here. Raw-only recovery no longer
// reads it, so discard the stale payload and allow SQLite to reuse those pages.
if (generationColumns.has('processed_content')) {
    db.exec(`UPDATE generation_jobs SET processed_content = NULL WHERE processed_content IS NOT NULL`);
}
// A process restart cannot resume an upstream HTTP socket. Preserve the bytes
// already committed and make the interrupted job available as a partial result.
db.prepare(`
    UPDATE generation_jobs
    SET status = 'interrupted',
        finish_reason = COALESCE(finish_reason, 'server_restart'),
        materialized_at = CASE
            WHEN job_type <> 'model' AND operation_context IS NULL
                THEN COALESCE(materialized_at, ?)
            ELSE materialized_at
        END,
        updated_at = ?
    WHERE status IN ('queued', 'generating')
`).run(Date.now(), Date.now());

const stmtCreate = db.prepare(`
    INSERT INTO generation_jobs (
        job_id, chat_id, job_type, character_id, room_id,
        is_continuation, continuation_prefix, generation_info, prompt_info, reroll_snapshot,
        operation_context,
        adapter_kind, streaming,
        status, created_at, updated_at
    ) VALUES (
        @jobId, @chatId, @jobType, @characterId, @roomId,
        @isContinuation, @continuationPrefix, @generationInfo, @promptInfo, @rerollSnapshot,
        @operationContext,
        @adapterKind, @streaming,
        'queued', @now, @now
    )
`);
const stmtGet = db.prepare(`SELECT * FROM generation_jobs WHERE job_id = ?`);
const stmtSetGenerating = db.prepare(`
    UPDATE generation_jobs
    SET status = 'generating', updated_at = ?
    WHERE job_id = ?
`);
const stmtSetHeaders = db.prepare(`
    UPDATE generation_jobs
    SET response_status = ?, response_headers = ?, updated_at = ?
    WHERE job_id = ?
`);
const stmtFinish = db.prepare(`
    UPDATE generation_jobs
    SET status = ?, finish_reason = ?, error = ?, raw_bytes = ?, completed_at = ?, updated_at = ?,
        materialized_at = CASE
            WHEN job_type <> 'model' AND operation_context IS NULL
                THEN COALESCE(materialized_at, ?)
            ELSE materialized_at
        END
    WHERE job_id = ?
`);
const stmtSetRawContent = db.prepare(`
    UPDATE generation_jobs
    SET raw_content = ?, updated_at = ?
    WHERE job_id = ?
`);
const stmtUpdateMetadata = db.prepare(`
    UPDATE generation_jobs
    SET generation_info = ?, prompt_info = ?, updated_at = ?
    WHERE job_id = ?
`);
const stmtListRecoverable = db.prepare(`
    SELECT *
    FROM generation_jobs
    WHERE chat_id IS NOT NULL
      AND job_type = 'model'
      AND status IN ('queued', 'generating', 'generated', 'cancelled', 'interrupted', 'failed_partial')
      AND (
        status IN ('queued', 'generating')
        OR length(raw_content) > 0
        OR (
            raw_bytes > 0
            AND response_status >= 200
            AND response_status < 300
        )
      )
      AND materialized_at IS NULL
    ORDER BY updated_at DESC
    LIMIT ?
`);
const stmtListRecoverableAuxiliary = db.prepare(`
    SELECT *
    FROM generation_jobs
    WHERE job_type <> 'model'
      AND operation_context IS NOT NULL
      AND status IN ('queued', 'generating', 'generated', 'cancelled', 'interrupted', 'failed_partial', 'failed')
      AND materialized_at IS NULL
    ORDER BY created_at ASC
    LIMIT ?
`);
const stmtMarkMaterialized = db.prepare(`
    UPDATE generation_jobs
    SET materialized_at = ?, updated_at = ?
    WHERE job_id = ?
`);
const stmtMaterializedPayloadTotal = db.prepare(`
    SELECT COALESCE(SUM(
        raw_bytes + length(CAST(raw_content AS BLOB))
        + length(CAST(COALESCE(generation_info, '') AS BLOB))
        + length(CAST(COALESCE(prompt_info, '') AS BLOB))
        + length(CAST(COALESCE(reroll_snapshot, '') AS BLOB))
        + length(CAST(COALESCE(operation_context, '') AS BLOB))
        + length(CAST(COALESCE(response_headers, '') AS BLOB))
        + length(CAST(COALESCE(continuation_prefix, '') AS BLOB))
        + length(CAST(COALESCE(error, '') AS BLOB))
    ), 0) AS total
    FROM generation_jobs
    WHERE materialized_at IS NOT NULL
`);
const stmtOldestMaterialized = db.prepare(`
    SELECT job_id, materialized_at,
        raw_bytes + length(CAST(raw_content AS BLOB))
        + length(CAST(COALESCE(generation_info, '') AS BLOB))
        + length(CAST(COALESCE(prompt_info, '') AS BLOB))
        + length(CAST(COALESCE(reroll_snapshot, '') AS BLOB))
        + length(CAST(COALESCE(operation_context, '') AS BLOB))
        + length(CAST(COALESCE(response_headers, '') AS BLOB))
        + length(CAST(COALESCE(continuation_prefix, '') AS BLOB))
        + length(CAST(COALESCE(error, '') AS BLOB)) AS payload_size
    FROM generation_jobs
    WHERE materialized_at IS NOT NULL
    ORDER BY materialized_at ASC, created_at ASC
`);
const stmtDeleteJob = db.prepare(`DELETE FROM generation_jobs WHERE job_id = ?`);
const stmtAllJobIds = db.prepare(`SELECT job_id FROM generation_jobs`);
const stmtSetRawBytes = db.prepare(`UPDATE generation_jobs SET raw_bytes = ? WHERE job_id = ?`);

// A process may stop after file append but before the terminal metadata update.
// The append-only file is authoritative, so reconcile its length on boot.
db.transaction(() => {
    for (const row of stmtAllJobIds.all()) {
        stmtSetRawBytes.run(generationJournalStore.size(row.job_id), row.job_id);
    }
})();

function rowToJob(row, includeRaw = true) {
    if (!row) return null;
    const rawResponse = includeRaw
        ? generationJournalStore.readAll(row.job_id)
        : undefined;
    const rawBytes = rawResponse?.length ?? Math.max(0, Number(row.raw_bytes) || 0);
    return {
        jobId: row.job_id,
        chatId: row.chat_id,
        jobType: row.job_type || 'model',
        characterId: row.character_id,
        roomId: row.room_id,
        isContinuation: row.is_continuation === 1,
        continuationPrefix: row.continuation_prefix || '',
        generationInfo: row.generation_info ? JSON.parse(row.generation_info) : undefined,
        promptInfo: row.prompt_info ? JSON.parse(row.prompt_info) : undefined,
        rerollSnapshot: row.reroll_snapshot ? JSON.parse(row.reroll_snapshot) : undefined,
        operationContext: row.operation_context ? JSON.parse(row.operation_context) : undefined,
        adapterKind: row.adapter_kind || undefined,
        streaming: row.streaming === 1,
        status: row.status,
        responseStatus: row.response_status,
        responseHeaders: row.response_headers ? JSON.parse(row.response_headers) : {},
        ...(includeRaw
            ? { rawResponse, rawBytes }
            : { rawBytes }),
        rawContent: row.raw_content || '',
        finishReason: row.finish_reason,
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        materializedAt: row.materialized_at,
    };
}

function createGenerationJob(input) {
    const now = Date.now();
    generationJournalStore.create(input.jobId);
    try {
        stmtCreate.run({
            jobId: input.jobId,
            chatId: input.chatId || null,
            jobType: input.jobType || 'model',
            characterId: input.characterId || null,
            roomId: input.roomId || null,
            isContinuation: input.isContinuation ? 1 : 0,
            continuationPrefix: input.continuationPrefix || null,
            generationInfo: input.generationInfo ? JSON.stringify(input.generationInfo) : null,
            promptInfo: input.promptInfo ? JSON.stringify(input.promptInfo) : null,
            rerollSnapshot: input.rerollSnapshot ? JSON.stringify(input.rerollSnapshot) : null,
            operationContext: input.operationContext ? JSON.stringify(input.operationContext) : null,
            adapterKind: typeof input.adapterKind === 'string' ? input.adapterKind.slice(0, 64) : null,
            streaming: input.streaming ? 1 : 0,
            now,
        });
    } catch (error) {
        generationJournalStore.remove(input.jobId);
        throw error;
    }
    return getGenerationJob(input.jobId);
}

function getGenerationJob(jobId, includeRaw = true) {
    return rowToJob(stmtGet.get(jobId), includeRaw);
}

function setGenerationJobGenerating(jobId) {
    stmtSetGenerating.run(Date.now(), jobId);
}

function setGenerationJobHeaders(jobId, status, headers) {
    stmtSetHeaders.run(status, JSON.stringify(headers || {}), Date.now(), jobId);
}

function finishGenerationJob(jobId, status, finishReason, error = null, rawBytes) {
    const now = Date.now();
    const journalBytes = Number.isSafeInteger(rawBytes) && rawBytes >= 0
        ? rawBytes
        : generationJournalStore.size(jobId);
    stmtFinish.run(status, finishReason || null, error || null, journalBytes, now, now, now, jobId);
}

function readGenerationJobRaw(jobId) {
    return generationJournalStore.readAll(jobId);
}

function setGenerationJobRawContent(jobId, rawContent) {
    const result = stmtSetRawContent.run(String(rawContent ?? ''), Date.now(), jobId);
    return result.changes === 1;
}

function updateGenerationJobMetadata(jobId, generationInfo, promptInfo) {
    const result = stmtUpdateMetadata.run(
        generationInfo ? JSON.stringify(generationInfo) : null,
        promptInfo ? JSON.stringify(promptInfo) : null,
        Date.now(),
        jobId,
    );
    return result.changes === 1;
}

function listRecoverableGenerationJobs(limit = 50) {
    const normalized = Math.max(1, Math.min(200, Number(limit) || 50));
    return stmtListRecoverable.all(normalized).map(row => rowToJob(row, false));
}

function listRecoverableAuxiliaryJobs(limit = 200) {
    const normalized = Math.max(1, Math.min(500, Number(limit) || 200));
    return stmtListRecoverableAuxiliary.all(normalized).map(row => rowToJob(row, false));
}

function markGenerationMaterialized(jobId) {
    const result = stmtMarkMaterialized.run(Date.now(), Date.now(), jobId);
    return result.changes === 1;
}

function pruneMaterializedGenerationJobs(
    maxBytes = 100 * 1024 * 1024,
    retentionMs = MATERIALIZED_RETENTION_MS,
) {
    const limit = Math.max(0, Number(maxBytes) || 0);
    const cutoff = Date.now() - Math.max(0, Number(retentionMs) || 0);
    let total = Number(stmtMaterializedPayloadTotal.get()?.total) || 0;
    const deletedJobIds = [];
    db.transaction(() => {
        for (const row of stmtOldestMaterialized.all()) {
            if (row.materialized_at > cutoff && total <= limit) break;
            stmtDeleteJob.run(row.job_id);
            total -= Number(row.payload_size) || 0;
            deletedJobIds.push(row.job_id);
        }
    })();
    for (const jobId of deletedJobIds) generationJournalStore.remove(jobId);
    const validJobIds = new Set(stmtAllJobIds.all().map(row => row.job_id));
    const orphaned = generationJournalStore.removeOrphans(validJobIds, cutoff);
    if (deletedJobIds.length > 0) db.pragma('wal_checkpoint(PASSIVE)');
    return {
        deleted: deletedJobIds.length,
        orphaned,
        bytes: Math.max(0, total),
    };
}

function checkpointGenerationDb(mode = 'PASSIVE') {
    db.pragma(`wal_checkpoint(${mode})`);
}

module.exports = {
    createGenerationJob,
    getGenerationJob,
    setGenerationJobGenerating,
    setGenerationJobHeaders,
    readGenerationJobRaw,
    setGenerationJobRawContent,
    updateGenerationJobMetadata,
    finishGenerationJob,
    listRecoverableGenerationJobs,
    listRecoverableAuxiliaryJobs,
    markGenerationMaterialized,
    pruneMaterializedGenerationJobs,
    checkpointGenerationDb,
};

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
        workflow_id TEXT,
        workflow_step_key TEXT,
        adapter_kind TEXT,
        streaming INTEGER NOT NULL DEFAULT 0,
        dispatch_group TEXT,
        dispatch_max_concurrent INTEGER,
        dispatch_requests_per_minute INTEGER,
        dispatched_at INTEGER,
        request_spec TEXT,
        status TEXT NOT NULL,
        response_status INTEGER,
        response_headers TEXT,
        raw_bytes INTEGER NOT NULL DEFAULT 0,
        normalized_projection TEXT,
        projection_error TEXT,
        projected_at INTEGER,
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
    CREATE TABLE IF NOT EXISTS generation_workflows (
        workflow_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        owner_client_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_workflows_active_room
        ON generation_workflows(character_id, room_id)
        WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_generation_workflows_status
        ON generation_workflows(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS generation_workflow_steps (
        workflow_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        step_order INTEGER NOT NULL,
        kind TEXT NOT NULL,
        recovery_policy TEXT NOT NULL,
        status TEXT NOT NULL,
        job_id TEXT,
        metadata TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, step_key)
    );
    CREATE INDEX IF NOT EXISTS idx_generation_workflow_steps_status
        ON generation_workflow_steps(workflow_id, status, step_order);
    CREATE TABLE IF NOT EXISTS generation_workflow_executions (
        workflow_id TEXT PRIMARY KEY,
        execution_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        recipe TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_generation_workflow_executions_status
        ON generation_workflow_executions(status, updated_at ASC);
`);
db.exec(`DROP INDEX IF EXISTS idx_generation_jobs_pending`);

const generationColumns = new Set(
    db.prepare(`PRAGMA table_info(generation_jobs)`).all().map(column => column.name)
);
if (!generationColumns.has('normalized_projection')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN normalized_projection TEXT`);
}
if (!generationColumns.has('projection_error')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN projection_error TEXT`);
}
if (!generationColumns.has('projected_at')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN projected_at INTEGER`);
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
if (!generationColumns.has('workflow_id')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN workflow_id TEXT`);
}
if (!generationColumns.has('workflow_step_key')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN workflow_step_key TEXT`);
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
if (!generationColumns.has('dispatch_group')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN dispatch_group TEXT`);
}
if (!generationColumns.has('dispatch_max_concurrent')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN dispatch_max_concurrent INTEGER`);
}
if (!generationColumns.has('dispatch_requests_per_minute')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN dispatch_requests_per_minute INTEGER`);
}
if (!generationColumns.has('dispatched_at')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN dispatched_at INTEGER`);
}
if (!generationColumns.has('request_spec')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN request_spec TEXT`);
}
// raw_response was used by the experimental SQLite-BLOB journal. Journals are
// now append-only files; do not keep two recovery sources alive indefinitely.
if (generationColumns.has('raw_response')) {
    db.exec(`UPDATE generation_jobs SET raw_response = X'' WHERE length(raw_response) > 0`);
}
// Older test builds cached client-side output here. The normalized projection
// has an explicit schema now, so discard this incompatible cache.
if (generationColumns.has('processed_content')) {
    db.exec(`UPDATE generation_jobs SET processed_content = NULL WHERE processed_content IS NOT NULL`);
}
// A process restart cannot resume an upstream HTTP socket. Requests that were
// durably queued but not dispatched retain request_spec and can be resumed;
// everything else becomes an interrupted attempt without being retried.
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
    WHERE status = 'generating'
       OR (status = 'queued' AND request_spec IS NULL)
`).run(Date.now(), Date.now());
db.prepare(`
    UPDATE generation_workflow_executions
    SET status = 'failed', recipe = '{}', error = 'server_restart',
        completed_at = ?, updated_at = ?
    WHERE status = 'running'
`).run(Date.now(), Date.now());
db.prepare(`
    UPDATE generation_workflow_steps
    SET status = 'waiting_client',
        metadata = '{"checkpoint":"selection.remote","reason":"server_restart"}',
        updated_at = ?
    WHERE step_key = 'memory.hypav3'
      AND workflow_id IN (
          SELECT workflow_id FROM generation_workflow_executions
          WHERE status = 'failed' AND error = 'server_restart'
      )
`).run(Date.now());
db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_active_main_room
    ON generation_jobs(character_id, room_id)
    WHERE job_type = 'model'
      AND character_id IS NOT NULL
      AND room_id IS NOT NULL
      AND status IN ('queued', 'generating')
`);

const stmtCreate = db.prepare(`
    INSERT INTO generation_jobs (
        job_id, chat_id, job_type, character_id, room_id,
        is_continuation, continuation_prefix, generation_info, prompt_info, reroll_snapshot,
        operation_context, workflow_id, workflow_step_key,
        adapter_kind, streaming,
        dispatch_group, dispatch_max_concurrent,
        dispatch_requests_per_minute, request_spec,
        status, created_at, updated_at
    ) VALUES (
        @jobId, @chatId, @jobType, @characterId, @roomId,
        @isContinuation, @continuationPrefix, @generationInfo, @promptInfo, @rerollSnapshot,
        @operationContext, @workflowId, @workflowStepKey,
        @adapterKind, @streaming,
        @dispatchGroup, @dispatchMaxConcurrent,
        @dispatchRequestsPerMinute, @requestSpec,
        'queued', @now, @now
    )
`);
const stmtGet = db.prepare(`SELECT * FROM generation_jobs WHERE job_id = ?`);
const stmtSetGenerating = db.prepare(`
    UPDATE generation_jobs
    SET status = 'generating', dispatched_at = COALESCE(dispatched_at, ?), updated_at = ?
    WHERE job_id = ? AND status = 'queued'
`);
const stmtSetHeaders = db.prepare(`
    UPDATE generation_jobs
    SET response_status = ?, response_headers = ?, updated_at = ?
    WHERE job_id = ?
`);
const stmtFinish = db.prepare(`
    UPDATE generation_jobs
    SET status = ?, finish_reason = ?, error = ?, raw_bytes = ?,
        request_spec = NULL, completed_at = ?, updated_at = ?,
        materialized_at = CASE
            WHEN job_type <> 'model' AND operation_context IS NULL
                THEN COALESCE(materialized_at, ?)
            ELSE materialized_at
        END
    WHERE job_id = ?
`);
const stmtSetProjection = db.prepare(`
    UPDATE generation_jobs
    SET normalized_projection = ?, projection_error = NULL,
        projected_at = ?, updated_at = ?
    WHERE job_id = ?
`);
const stmtSetClientProjection = db.prepare(`
    UPDATE generation_jobs
    SET normalized_projection = ?, projection_error = NULL,
        projected_at = ?, updated_at = ?
    WHERE job_id = ?
      AND CASE
        WHEN json_valid(normalized_projection)
            THEN COALESCE(json_extract(normalized_projection, '$.source'), '')
        ELSE ''
      END <> 'server'
`);
const stmtSetProjectionError = db.prepare(`
    UPDATE generation_jobs
    SET projection_error = ?, updated_at = ?
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
      AND status IN ('queued', 'generating', 'generated', 'cancelled', 'interrupted', 'failed_partial', 'failed')
      AND (
        status IN ('queued', 'generating')
        OR length(normalized_projection) > 0
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
const stmtListNeedingProjection = db.prepare(`
    SELECT *
    FROM generation_jobs
    WHERE raw_bytes > 0
      AND response_status >= 200
      AND response_status < 300
      AND (
        normalized_projection IS NULL
        OR CASE
            WHEN json_valid(normalized_projection)
                THEN COALESCE(json_extract(normalized_projection, '$.schemaVersion'), 0)
            ELSE 0
        END <> ?
        OR CASE
            WHEN json_valid(normalized_projection)
                THEN COALESCE(json_extract(normalized_projection, '$.source'), '')
            ELSE ''
        END <> 'server'
      )
      AND status IN ('generated', 'interrupted', 'cancelled', 'failed_partial', 'failed')
    ORDER BY updated_at ASC
    LIMIT ?
`);
const stmtListQueuedDispatches = db.prepare(`
    SELECT *
    FROM generation_jobs
    WHERE status = 'queued' AND request_spec IS NOT NULL
    ORDER BY created_at ASC
    LIMIT ?
`);
const stmtDispatchState = db.prepare(`
    SELECT
        COALESCE(SUM(CASE WHEN status = 'generating' THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN dispatched_at >= ? THEN 1 ELSE 0 END), 0) AS recent,
        MIN(CASE WHEN dispatched_at >= ? THEN dispatched_at ELSE NULL END) AS oldest_recent
    FROM generation_jobs
    WHERE dispatch_group = ?
`);
const stmtClaimDispatch = db.prepare(`
    UPDATE generation_jobs
    SET status = 'generating', request_spec = NULL,
        dispatched_at = ?, updated_at = ?
    WHERE job_id = ? AND status = 'queued' AND request_spec IS NOT NULL
`);
const stmtMarkMaterialized = db.prepare(`
    UPDATE generation_jobs
    SET materialized_at = ?, updated_at = ?
    WHERE job_id = ?
`);
const stmtMaterializedPayloadTotal = db.prepare(`
    SELECT COALESCE(SUM(
        raw_bytes + length(CAST(COALESCE(normalized_projection, '') AS BLOB))
        + length(CAST(COALESCE(projection_error, '') AS BLOB))
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
    SELECT job_id, workflow_id, materialized_at,
        raw_bytes + length(CAST(COALESCE(normalized_projection, '') AS BLOB))
        + length(CAST(COALESCE(projection_error, '') AS BLOB))
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
const stmtAllJobIds = db.prepare(`SELECT job_id, workflow_id FROM generation_jobs`);
const stmtSetRawBytes = db.prepare(`UPDATE generation_jobs SET raw_bytes = ? WHERE job_id = ?`);
const stmtCreateWorkflow = db.prepare(`
    INSERT INTO generation_workflows (
        workflow_id, character_id, room_id, owner_client_id,
        plan_version, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)
`);
const stmtCreateWorkflowStep = db.prepare(`
    INSERT INTO generation_workflow_steps (
        workflow_id, step_key, step_order, kind, recovery_policy,
        status, metadata, started_at, completed_at, updated_at
    ) VALUES (
        @workflowId, @key, @order, @kind, @recoveryPolicy,
        @status, @metadata,
        CASE WHEN @status = 'completed' THEN @now ELSE NULL END,
        CASE WHEN @status IN ('completed', 'skipped') THEN @now ELSE NULL END,
        @now
    )
`);
const stmtGetWorkflow = db.prepare(`SELECT * FROM generation_workflows WHERE workflow_id = ?`);
const stmtGetActiveWorkflowForRoom = db.prepare(`
    SELECT * FROM generation_workflows
    WHERE character_id = ? AND room_id = ? AND status = 'active'
    LIMIT 1
`);
const stmtListWorkflowSteps = db.prepare(`
    SELECT * FROM generation_workflow_steps
    WHERE workflow_id = ?
    ORDER BY step_order ASC
`);
const stmtGetWorkflowStep = db.prepare(`
    SELECT * FROM generation_workflow_steps WHERE workflow_id = ? AND step_key = ?
`);
const stmtNextWorkflowStepOrder = db.prepare(`
    SELECT COALESCE(MAX(step_order), -1) + 1 AS next_order
    FROM generation_workflow_steps WHERE workflow_id = ?
`);
const stmtInsertDynamicWorkflowStep = db.prepare(`
    INSERT INTO generation_workflow_steps (
        workflow_id, step_key, step_order, kind, recovery_policy,
        status, job_id, metadata, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateWorkflowStep = db.prepare(`
    UPDATE generation_workflow_steps
    SET status = ?, job_id = COALESCE(?, job_id), metadata = COALESCE(?, metadata),
        started_at = CASE
            WHEN ? IN ('running', 'waiting_client', 'waiting_job') THEN COALESCE(started_at, ?)
            ELSE started_at
        END,
        completed_at = CASE
            WHEN ? IN ('completed', 'skipped', 'failed') THEN ?
            ELSE NULL
        END,
        updated_at = ?
    WHERE workflow_id = ? AND step_key = ?
`);
const stmtTouchWorkflow = db.prepare(`
    UPDATE generation_workflows SET updated_at = ? WHERE workflow_id = ? AND status = 'active'
`);
const stmtClaimWorkflow = db.prepare(`
    UPDATE generation_workflows
    SET owner_client_id = ?, updated_at = ?
    WHERE workflow_id = ? AND status = 'active' AND owner_client_id = ?
`);
const stmtFinishWorkflow = db.prepare(`
    UPDATE generation_workflows
    SET status = ?, completed_at = ?, updated_at = ?
    WHERE workflow_id = ? AND status = 'active'
`);
const stmtCancelWorkflowExecution = db.prepare(`
    UPDATE generation_workflow_executions
    SET status = 'failed', recipe = '{}', error = 'workflow_finished',
        completed_at = ?, updated_at = ?
    WHERE workflow_id = ? AND status = 'queued'
`);
const stmtDeleteCompletedWorkflowSteps = db.prepare(`
    DELETE FROM generation_workflow_steps
    WHERE workflow_id IN (
        SELECT workflow_id FROM generation_workflows
        WHERE status <> 'active' AND completed_at < ?
    )
`);
const stmtDeleteCompletedWorkflows = db.prepare(`
    DELETE FROM generation_workflows
    WHERE status <> 'active' AND completed_at < ?
`);
const stmtPutWorkflowExecution = db.prepare(`
    INSERT INTO generation_workflow_executions (
        workflow_id, execution_kind, status, recipe, created_at, updated_at
    ) VALUES (?, ?, 'queued', ?, ?, ?)
    ON CONFLICT(workflow_id) DO NOTHING
`);
const stmtGetWorkflowExecution = db.prepare(`
    SELECT * FROM generation_workflow_executions WHERE workflow_id = ?
`);
const stmtListQueuedWorkflowExecutions = db.prepare(`
    SELECT * FROM generation_workflow_executions
    WHERE execution_kind = 'hypav3-selection' AND status = 'queued'
    ORDER BY created_at ASC LIMIT ?
`);
const stmtClaimWorkflowExecution = db.prepare(`
    UPDATE generation_workflow_executions
    SET status = 'running', updated_at = ?
    WHERE workflow_id = ? AND status = 'queued'
`);
const stmtRequeueWorkflowExecution = db.prepare(`
    UPDATE generation_workflow_executions
    SET status = 'queued', updated_at = ?
    WHERE workflow_id = ? AND status = 'running'
`);
const stmtFinishWorkflowExecution = db.prepare(`
    UPDATE generation_workflow_executions
    SET status = ?, result = ?, error = ?, recipe = '{}',
        completed_at = ?, updated_at = ?
    WHERE workflow_id = ? AND status IN ('queued', 'running')
`);
const stmtListWorkflowJobs = db.prepare(`
    SELECT * FROM generation_jobs WHERE workflow_id = ? ORDER BY created_at ASC
`);
const stmtDeleteCompletedWorkflowExecutions = db.prepare(`
    DELETE FROM generation_workflow_executions
    WHERE status IN ('completed', 'failed') AND completed_at < ?
`);

// A process may stop after file append but before the terminal metadata update.
// The append-only file is authoritative, so reconcile its length on boot.
db.transaction(() => {
    for (const row of stmtAllJobIds.all()) {
        stmtSetRawBytes.run(
            generationJournalStore.size(row.workflow_id, row.job_id),
            row.job_id,
        );
    }
})();

function rowToWorkflowStep(row) {
    return {
        key: row.step_key,
        order: row.step_order,
        kind: row.kind,
        recoveryPolicy: row.recovery_policy,
        status: row.status,
        jobId: row.job_id || undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        startedAt: row.started_at || undefined,
        completedAt: row.completed_at || undefined,
        updatedAt: row.updated_at,
    };
}

function rowToWorkflow(row, includeSteps = true) {
    if (!row) return null;
    return {
        workflowId: row.workflow_id,
        characterId: row.character_id,
        roomId: row.room_id,
        ownerClientId: row.owner_client_id,
        planVersion: row.plan_version,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at || undefined,
        ...(includeSteps
            ? { steps: stmtListWorkflowSteps.all(row.workflow_id).map(rowToWorkflowStep) }
            : {}),
    };
}

function getGenerationWorkflow(workflowId, includeSteps = true) {
    return rowToWorkflow(stmtGetWorkflow.get(workflowId), includeSteps);
}

function getActiveGenerationWorkflow(characterId, roomId, includeSteps = true) {
    return rowToWorkflow(
        stmtGetActiveWorkflowForRoom.get(characterId, roomId),
        includeSteps,
    );
}

function createGenerationWorkflow(input) {
    const now = Date.now();
    try {
        db.transaction(() => {
            stmtCreateWorkflow.run(
                input.workflowId,
                input.characterId,
                input.roomId,
                input.ownerClientId,
                now,
                now,
            );
            for (const step of input.plan) {
                stmtCreateWorkflowStep.run({
                    workflowId: input.workflowId,
                    ...step,
                    metadata: step.metadata ? JSON.stringify(step.metadata) : null,
                    now,
                });
            }
        })();
    } catch (error) {
        if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return {
                busy: true,
                workflow: getActiveGenerationWorkflow(input.characterId, input.roomId),
            };
        }
        throw error;
    }
    return { busy: false, workflow: getGenerationWorkflow(input.workflowId) };
}

function claimGenerationWorkflow(workflowId, ownerClientId, expectedOwnerClientId) {
    const now = Date.now();
    const result = stmtClaimWorkflow.run(
        ownerClientId,
        now,
        workflowId,
        expectedOwnerClientId,
    );
    return result.changes === 1 ? getGenerationWorkflow(workflowId) : null;
}

function updateGenerationWorkflowStep(
    workflowId,
    stepKey,
    update,
    dynamic = undefined,
) {
    const workflow = stmtGetWorkflow.get(workflowId);
    if (!workflow || workflow.status !== 'active') return false;
    const now = Date.now();
    db.transaction(() => {
        if (!stmtGetWorkflowStep.get(workflowId, stepKey)) {
            if (!dynamic) throw new Error(`Unknown generation workflow step: ${stepKey}`);
            const terminal = ['completed', 'skipped', 'failed'].includes(update.status);
            stmtInsertDynamicWorkflowStep.run(
                workflowId,
                stepKey,
                stmtNextWorkflowStepOrder.get(workflowId).next_order,
                dynamic.kind,
                dynamic.recoveryPolicy,
                update.status,
                update.jobId || null,
                update.metadata ? JSON.stringify(update.metadata) : null,
                ['running', 'waiting_client', 'waiting_job'].includes(update.status) ? now : null,
                terminal ? now : null,
                now,
            );
        } else {
            const metadata = update.metadata ? JSON.stringify(update.metadata) : null;
            stmtUpdateWorkflowStep.run(
                update.status,
                update.jobId || null,
                metadata,
                update.status,
                now,
                update.status,
                now,
                now,
                workflowId,
                stepKey,
            );
        }
        stmtTouchWorkflow.run(now, workflowId);
    })();
    return true;
}

function finishGenerationWorkflow(workflowId, status) {
    const now = Date.now();
    const changed = stmtFinishWorkflow.run(status, now, now, workflowId).changes === 1;
    if (changed) stmtCancelWorkflowExecution.run(now, now, workflowId);
    return changed;
}

function rowToWorkflowExecution(row, includeRecipe = false) {
    if (!row) return null;
    return {
        workflowId: row.workflow_id,
        kind: row.execution_kind,
        status: row.status,
        ...(includeRecipe ? { recipe: JSON.parse(row.recipe) } : {}),
        result: row.result ? JSON.parse(row.result) : undefined,
        error: row.error || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at || undefined,
    };
}

function putGenerationWorkflowExecution(workflowId, kind, recipe) {
    const workflow = stmtGetWorkflow.get(workflowId);
    if (!workflow || workflow.status !== 'active') return null;
    const now = Date.now();
    stmtPutWorkflowExecution.run(workflowId, kind, JSON.stringify(recipe), now, now);
    return rowToWorkflowExecution(stmtGetWorkflowExecution.get(workflowId));
}

function getGenerationWorkflowExecution(workflowId, includeRecipe = false) {
    return rowToWorkflowExecution(stmtGetWorkflowExecution.get(workflowId), includeRecipe);
}

function listQueuedGenerationWorkflowExecutions(limit = 20) {
    return stmtListQueuedWorkflowExecutions
        .all(Math.max(1, Math.min(100, Number(limit) || 20)))
        .map(row => rowToWorkflowExecution(row, true));
}

function claimGenerationWorkflowExecution(workflowId) {
    const now = Date.now();
    if (stmtClaimWorkflowExecution.run(now, workflowId).changes !== 1) return null;
    return getGenerationWorkflowExecution(workflowId, true);
}

function requeueGenerationWorkflowExecution(workflowId) {
    return stmtRequeueWorkflowExecution.run(Date.now(), workflowId).changes === 1;
}

function finishGenerationWorkflowExecution(workflowId, status, result, error) {
    const now = Date.now();
    return stmtFinishWorkflowExecution.run(
        status,
        result ? JSON.stringify(result) : null,
        error || null,
        now,
        now,
        workflowId,
    ).changes === 1;
}

function listGenerationWorkflowJobs(workflowId) {
    return stmtListWorkflowJobs.all(workflowId).map(row => rowToJob(row, false));
}

function linkGenerationJobToWorkflow(input) {
    if (!input.workflowId) return;
    const workflow = stmtGetWorkflow.get(input.workflowId);
    if (
        !workflow
        || workflow.status !== 'active'
        || workflow.character_id !== input.characterId
        || workflow.room_id !== input.roomId
    ) {
        const error = new Error('Generation workflow is not active for this room');
        error.httpStatus = 409;
        throw error;
    }
    updateGenerationWorkflowStep(
        input.workflowId,
        input.workflowStepKey,
        { status: 'waiting_job', jobId: input.jobId },
        {
            kind: input.jobType === 'model' ? 'model.main' : `job.${input.jobType}`,
            recoveryPolicy: 'replay_output',
        },
    );
}

function updateGenerationJobWorkflowStep(jobId, status) {
    const row = stmtGet.get(jobId);
    if (!row?.workflow_id || !row.workflow_step_key) return;
    updateGenerationWorkflowStep(
        row.workflow_id,
        row.workflow_step_key,
        { status, jobId },
        {
            kind: row.job_type === 'model' ? 'model.main' : `job.${row.job_type}`,
            recoveryPolicy: 'replay_output',
        },
    );
}

function rowToJob(row, includeRaw = true) {
    if (!row) return null;
    const rawResponse = includeRaw
        ? generationJournalStore.readAll(row.workflow_id, row.job_id)
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
        workflowId: row.workflow_id || undefined,
        workflowStepKey: row.workflow_step_key || undefined,
        adapterKind: row.adapter_kind || undefined,
        streaming: row.streaming === 1,
        status: row.status,
        responseStatus: row.response_status,
        responseHeaders: row.response_headers ? JSON.parse(row.response_headers) : {},
        ...(includeRaw
            ? { rawResponse, rawBytes }
            : { rawBytes }),
        projection: parseNormalizedProjection(row.normalized_projection),
        projectionError: row.projection_error || undefined,
        projectedAt: row.projected_at || undefined,
        finishReason: row.finish_reason,
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        materializedAt: row.materialized_at,
    };
}

function parseNormalizedProjection(value) {
    if (!value) return undefined;
    try {
        const projection = JSON.parse(value);
        if (
            projection?.schemaVersion !== 1
            || !['server', 'client'].includes(projection.source)
            || typeof projection.adapterKind !== 'string'
            || typeof projection.content !== 'string'
        ) return undefined;
        return projection;
    } catch {
        return undefined;
    }
}

function createGenerationJob(input) {
    const now = Date.now();
    const activeWorkflow = input.characterId && input.roomId
        ? stmtGetActiveWorkflowForRoom.get(input.characterId, input.roomId)
        : null;
    if (activeWorkflow && activeWorkflow.workflow_id !== input.workflowId) {
        const error = new Error('A generation workflow is already active for this room');
        error.httpStatus = 409;
        error.workflowId = activeWorkflow.workflow_id;
        throw error;
    }
    if (input.workflowId && !input.workflowStepKey) {
        const error = new Error('workflowStepKey is required when workflowId is set');
        error.httpStatus = 400;
        throw error;
    }
    generationJournalStore.create(input.workflowId || null, input.jobId);
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
            workflowId: input.workflowId || null,
            workflowStepKey: input.workflowStepKey || null,
            adapterKind: typeof input.adapterKind === 'string' ? input.adapterKind.slice(0, 64) : null,
            streaming: input.streaming ? 1 : 0,
            dispatchGroup: input.dispatchGroup || null,
            dispatchMaxConcurrent: input.dispatchMaxConcurrent || null,
            dispatchRequestsPerMinute: input.dispatchRequestsPerMinute || null,
            requestSpec: input.requestSpec ? JSON.stringify(input.requestSpec) : null,
            now,
        });
        linkGenerationJobToWorkflow(input);
    } catch (error) {
        stmtDeleteJob.run(input.jobId);
        generationJournalStore.remove(input.workflowId || null, input.jobId);
        throw error;
    }
    return getGenerationJob(input.jobId);
}

function getGenerationJob(jobId, includeRaw = true) {
    return rowToJob(stmtGet.get(jobId), includeRaw);
}

function setGenerationJobGenerating(jobId) {
    const now = Date.now();
    stmtSetGenerating.run(now, now, jobId);
    updateGenerationJobWorkflowStep(jobId, 'waiting_job');
}

function listQueuedGenerationDispatches(limit = 500) {
    const normalized = Math.max(1, Math.min(1000, Number(limit) || 500));
    return stmtListQueuedDispatches.all(normalized).map(row => ({
        job: rowToJob(row, false),
        dispatchGroup: row.dispatch_group,
        maxConcurrent: Math.max(1, Number(row.dispatch_max_concurrent) || 1),
        requestsPerMinute: Math.max(1, Number(row.dispatch_requests_per_minute) || 1),
        requestSpec: JSON.parse(row.request_spec),
    }));
}

function getGenerationDispatchState(dispatchGroup, since) {
    const row = stmtDispatchState.get(since, since, dispatchGroup);
    return {
        active: Math.max(0, Number(row?.active) || 0),
        recent: Math.max(0, Number(row?.recent) || 0),
        oldestRecent: row?.oldest_recent || undefined,
    };
}

function claimQueuedGenerationDispatch(jobId) {
    const row = stmtGet.get(jobId);
    if (!row?.request_spec || row.status !== 'queued') return undefined;
    const requestSpec = JSON.parse(row.request_spec);
    const now = Date.now();
    const result = stmtClaimDispatch.run(now, now, jobId);
    if (result.changes !== 1) return undefined;
    updateGenerationJobWorkflowStep(jobId, 'waiting_job');
    return { job: rowToJob({ ...row, status: 'generating', request_spec: null }, false), requestSpec };
}

function setGenerationJobHeaders(jobId, status, headers) {
    stmtSetHeaders.run(status, JSON.stringify(headers || {}), Date.now(), jobId);
}

function finishGenerationJob(jobId, status, finishReason, error = null, rawBytes) {
    const now = Date.now();
    const job = stmtGet.get(jobId);
    const journalBytes = Number.isSafeInteger(rawBytes) && rawBytes >= 0
        ? rawBytes
        : generationJournalStore.size(job?.workflow_id, jobId);
    stmtFinish.run(status, finishReason || null, error || null, journalBytes, now, now, now, jobId);
    updateGenerationJobWorkflowStep(
        jobId,
        status === 'generated' ? 'output_ready' : 'failed',
    );
}

function readGenerationJobRaw(jobId) {
    const job = stmtGet.get(jobId);
    return generationJournalStore.readAll(job?.workflow_id, jobId);
}

function setGenerationJobProjection(jobId, projection) {
    const now = Date.now();
    const result = stmtSetProjection.run(JSON.stringify(projection), now, now, jobId);
    return result.changes === 1;
}

function setGenerationJobClientProjection(jobId, projection) {
    const now = Date.now();
    const result = stmtSetClientProjection.run(JSON.stringify(projection), now, now, jobId);
    return result.changes === 1;
}

function setGenerationJobProjectionError(jobId, error) {
    const result = stmtSetProjectionError.run(String(error ?? ''), Date.now(), jobId);
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

function listGenerationJobsNeedingProjection(limit = 200, schemaVersion = 1) {
    const normalized = Math.max(1, Math.min(500, Number(limit) || 200));
    return stmtListNeedingProjection
        .all(Number(schemaVersion) || 1, normalized)
        .map(row => rowToJob(row, false));
}

function markGenerationMaterialized(jobId) {
    const job = stmtGet.get(jobId);
    const result = stmtMarkMaterialized.run(Date.now(), Date.now(), jobId);
    if (result.changes === 1) {
        updateGenerationJobWorkflowStep(
            jobId,
            job?.job_type !== 'model' && job?.status !== 'generated'
                ? 'failed'
                : 'completed',
        );
        if (job?.job_type === 'model' && job.workflow_id) {
            updateGenerationWorkflowStep(
                job.workflow_id,
                'message.materialize',
                { status: 'completed', jobId },
                { kind: 'message.materialize', recoveryPolicy: 'resume' },
            );
        }
    }
    return result.changes === 1;
}

function pruneMaterializedGenerationJobs(
    maxBytes = 100 * 1024 * 1024,
    retentionMs = MATERIALIZED_RETENTION_MS,
) {
    const limit = Math.max(0, Number(maxBytes) || 0);
    const cutoff = Date.now() - Math.max(0, Number(retentionMs) || 0);
    let total = Number(stmtMaterializedPayloadTotal.get()?.total) || 0;
    const deletedJobs = [];
    db.transaction(() => {
        for (const row of stmtOldestMaterialized.all()) {
            if (row.materialized_at > cutoff && total <= limit) break;
            stmtDeleteJob.run(row.job_id);
            total -= Number(row.payload_size) || 0;
            deletedJobs.push({ jobId: row.job_id, workflowId: row.workflow_id });
        }
    })();
    for (const job of deletedJobs) {
        generationJournalStore.remove(job.workflowId, job.jobId);
    }
    const validJournals = new Set(stmtAllJobIds.all().map(row =>
        generationJournalStore.journalKey(row.workflow_id, row.job_id)));
    const orphaned = generationJournalStore.removeOrphans(validJournals, cutoff);
    let workflowsDeleted = 0;
    db.transaction(() => {
        stmtDeleteCompletedWorkflowExecutions.run(cutoff);
        stmtDeleteCompletedWorkflowSteps.run(cutoff);
        workflowsDeleted = stmtDeleteCompletedWorkflows.run(cutoff).changes;
    })();
    if (deletedJobs.length > 0) db.pragma('wal_checkpoint(PASSIVE)');
    return {
        deleted: deletedJobs.length,
        orphaned,
        workflowsDeleted,
        bytes: Math.max(0, total),
    };
}

function checkpointGenerationDb(mode = 'PASSIVE') {
    db.pragma(`wal_checkpoint(${mode})`);
}

module.exports = {
    createGenerationWorkflow,
    getGenerationWorkflow,
    getActiveGenerationWorkflow,
    claimGenerationWorkflow,
    updateGenerationWorkflowStep,
    finishGenerationWorkflow,
    putGenerationWorkflowExecution,
    getGenerationWorkflowExecution,
    listQueuedGenerationWorkflowExecutions,
    claimGenerationWorkflowExecution,
    requeueGenerationWorkflowExecution,
    finishGenerationWorkflowExecution,
    listGenerationWorkflowJobs,
    createGenerationJob,
    getGenerationJob,
    setGenerationJobGenerating,
    listQueuedGenerationDispatches,
    getGenerationDispatchState,
    claimQueuedGenerationDispatch,
    setGenerationJobHeaders,
    readGenerationJobRaw,
    setGenerationJobProjection,
    setGenerationJobClientProjection,
    setGenerationJobProjectionError,
    updateGenerationJobMetadata,
    finishGenerationJob,
    listRecoverableGenerationJobs,
    listRecoverableAuxiliaryJobs,
    listGenerationJobsNeedingProjection,
    markGenerationMaterialized,
    pruneMaterializedGenerationJobs,
    checkpointGenerationDb,
};

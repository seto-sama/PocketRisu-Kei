'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { generationJournalStore } = require('./generationJournal.cjs');
const { cancelActiveGenerationWork } = require('./generationRestart.cjs');

const GENERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLIENT_ACTION_LEASE_MS = 5 * 60 * 1000;

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
        step_execution_id TEXT,
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
        owner_epoch INTEGER NOT NULL DEFAULT 1,
        plan_version INTEGER NOT NULL DEFAULT 1,
        context TEXT,
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
        metadata TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, step_key)
    );
    CREATE INDEX IF NOT EXISTS idx_generation_workflow_steps_status
        ON generation_workflow_steps(workflow_id, status, step_order);
    CREATE TABLE IF NOT EXISTS generation_workflow_step_executions (
        execution_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_step_executions_attempt
        ON generation_workflow_step_executions(workflow_id, step_key, attempt);
    CREATE INDEX IF NOT EXISTS idx_generation_step_executions_status
        ON generation_workflow_step_executions(workflow_id, status, updated_at DESC);
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
const workflowColumns = new Set(
    db.prepare(`PRAGMA table_info(generation_workflows)`).all().map(column => column.name)
);
if (!workflowColumns.has('owner_epoch')) {
    db.exec(`ALTER TABLE generation_workflows ADD COLUMN owner_epoch INTEGER NOT NULL DEFAULT 1`);
}
if (!workflowColumns.has('context')) {
    db.exec(`ALTER TABLE generation_workflows ADD COLUMN context TEXT`);
}
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
if (!generationColumns.has('step_execution_id')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN step_execution_id TEXT`);
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
// A browser disconnect is recoverable, but a server process restart ends the
// workflow. Keep partial journals for retention/recovery, while ensuring no
// queued provider request is resumed by the new process.
const restartAt = Date.now();
cancelActiveGenerationWork(db, restartAt);
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
        operation_context, workflow_id, workflow_step_key, step_execution_id,
        adapter_kind, streaming,
        dispatch_group, dispatch_max_concurrent,
        dispatch_requests_per_minute, request_spec,
        status, created_at, updated_at
    ) VALUES (
        @jobId, @chatId, @jobType, @characterId, @roomId,
        @isContinuation, @continuationPrefix, @generationInfo, @promptInfo, @rerollSnapshot,
        @operationContext, @workflowId, @workflowStepKey, @stepExecutionId,
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
        request_spec = NULL, completed_at = ?, updated_at = ?
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
const stmtAcknowledgeSupersededWorkflowStepJobs = db.prepare(`
    UPDATE generation_jobs
    SET materialized_at = COALESCE(materialized_at, ?), updated_at = ?
    WHERE workflow_id = ?
      AND workflow_step_key = ?
      AND job_id <> ?
      AND status NOT IN ('queued', 'generating')
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
const stmtDeleteJob = db.prepare(`DELETE FROM generation_jobs WHERE job_id = ?`);
const stmtAllJobIds = db.prepare(`SELECT job_id, workflow_id FROM generation_jobs`);
const stmtSetRawBytes = db.prepare(`UPDATE generation_jobs SET raw_bytes = ? WHERE job_id = ?`);
const stmtExpiredTerminalJobs = db.prepare(`
    SELECT job_id, workflow_id
    FROM generation_jobs
    WHERE status NOT IN ('queued', 'generating')
      AND completed_at IS NOT NULL
      AND completed_at < ?
    ORDER BY completed_at ASC, created_at ASC
`);
const stmtCreateWorkflow = db.prepare(`
    INSERT INTO generation_workflows (
        workflow_id, character_id, room_id, owner_client_id, owner_epoch,
        plan_version, context, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 1, ?, 'active', ?, ?)
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
const stmtListReadyChatWorkflowJobs = db.prepare(`
    SELECT job_id
    FROM generation_jobs
    WHERE workflow_id IN (
        SELECT workflow_id FROM generation_workflows
        WHERE status = 'active' AND context IS NOT NULL
    )
      AND job_type = 'model'
      AND workflow_step_key = 'model.main'
      AND status = 'generated'
      AND normalized_projection IS NOT NULL
      AND materialized_at IS NULL
    ORDER BY completed_at ASC, created_at ASC
    LIMIT ?
`);
const stmtClaimWorkflowStep = db.prepare(`
    UPDATE generation_workflow_steps
    SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE workflow_id = ? AND step_key = ? AND status = ?
      AND EXISTS (
          SELECT 1 FROM generation_workflows
          WHERE workflow_id = ? AND status = 'active'
      )
`);
const stmtGetStepExecution = db.prepare(`
    SELECT * FROM generation_workflow_step_executions WHERE execution_id = ?
`);
const stmtListStepExecutions = db.prepare(`
    SELECT * FROM generation_workflow_step_executions
    WHERE workflow_id = ? AND step_key = ?
    ORDER BY attempt ASC
`);
const stmtCreateStepExecution = db.prepare(`
    INSERT INTO generation_workflow_step_executions (
        execution_id, workflow_id, step_key, attempt, status,
        created_at, updated_at
    )
    SELECT ?, ?, ?, COALESCE(MAX(attempt), 0) + 1, ?, ?, ?
    FROM generation_workflow_step_executions
    WHERE workflow_id = ? AND step_key = ?
`);
const stmtUpdateStepExecution = db.prepare(`
    UPDATE generation_workflow_step_executions
    SET status = ?,
        completed_at = CASE
            WHEN ? IN ('completed', 'skipped', 'failed') THEN ?
            ELSE NULL
        END,
        updated_at = ?
    WHERE execution_id = ?
`);
const stmtNextWorkflowStepOrder = db.prepare(`
    SELECT COALESCE(MAX(step_order), -1) + 1 AS next_order
    FROM generation_workflow_steps WHERE workflow_id = ?
`);
const stmtInsertDynamicWorkflowStep = db.prepare(`
    INSERT INTO generation_workflow_steps (
        workflow_id, step_key, step_order, kind, recovery_policy,
        status, metadata, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateWorkflowStep = db.prepare(`
    UPDATE generation_workflow_steps
    SET status = ?, metadata = COALESCE(?, metadata),
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
    SET owner_client_id = ?, owner_epoch = owner_epoch + 1, updated_at = ?
    WHERE workflow_id = ? AND status = 'active'
      AND owner_client_id = ? AND owner_epoch = ?
`);
const stmtFinishWorkflow = db.prepare(`
    UPDATE generation_workflows
    SET status = ?, completed_at = ?, updated_at = ?
    WHERE workflow_id = ? AND status = 'active'
`);
const stmtCancelWorkflowExecutions = db.prepare(`
    UPDATE generation_workflow_executions
    SET status = 'failed', recipe = '{}', error = ?,
        completed_at = ?, updated_at = ?
    WHERE workflow_id = ? AND status IN ('queued', 'running')
`);
const stmtCancelQueuedWorkflowExecutions = db.prepare(`
    UPDATE generation_workflow_executions
    SET status = 'failed', recipe = '{}', error = 'workflow_completed',
        completed_at = ?, updated_at = ?
    WHERE workflow_id = ? AND status = 'queued'
`);
const stmtListActiveWorkflowJobs = db.prepare(`
    SELECT job_id, status FROM generation_jobs
    WHERE workflow_id = ? AND status IN ('queued', 'generating')
`);
const stmtListActiveStepExecutionJobs = db.prepare(`
    SELECT job_id, status FROM generation_jobs
    WHERE workflow_id = ? AND step_execution_id = ?
      AND status IN ('queued', 'generating')
`);
const stmtAcknowledgeStepExecutionJobs = db.prepare(`
    UPDATE generation_jobs
    SET materialized_at = COALESCE(materialized_at, ?), updated_at = ?
    WHERE workflow_id = ? AND step_execution_id = ?
`);
const stmtCancelStepExecutionJobs = db.prepare(`
    UPDATE generation_jobs
    SET status = 'cancelled', finish_reason = 'step_cancelled', error = NULL,
        request_spec = NULL, completed_at = ?, updated_at = ?
    WHERE workflow_id = ? AND step_execution_id = ?
      AND status IN ('queued', 'generating')
`);
const stmtAcknowledgeWorkflowJobs = db.prepare(`
    UPDATE generation_jobs
    SET materialized_at = COALESCE(materialized_at, ?)
    WHERE workflow_id = ?
`);
const stmtCancelWorkflowJobs = db.prepare(`
    UPDATE generation_jobs
    SET status = 'cancelled', finish_reason = ?, error = NULL,
        request_spec = NULL,
        completed_at = ?, updated_at = ?
    WHERE workflow_id = ? AND status IN ('queued', 'generating')
`);
const stmtFailActiveWorkflowSteps = db.prepare(`
    UPDATE generation_workflow_steps
    SET status = 'failed', completed_at = ?, updated_at = ?
    WHERE workflow_id = ?
      AND status NOT IN ('completed', 'skipped', 'failed')
`);
const stmtFailActiveStepExecutions = db.prepare(`
    UPDATE generation_workflow_step_executions
    SET status = 'failed', completed_at = ?, updated_at = ?
    WHERE workflow_id = ?
      AND status NOT IN ('completed', 'skipped', 'failed')
`);
const stmtDeleteCompletedStepExecutions = db.prepare(`
    DELETE FROM generation_workflow_step_executions
    WHERE workflow_id IN (
        SELECT workflow_id FROM generation_workflows
        WHERE status <> 'active' AND completed_at < ?
    )
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
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        startedAt: row.started_at || undefined,
        completedAt: row.completed_at || undefined,
        updatedAt: row.updated_at,
        executions: stmtListStepExecutions
            .all(row.workflow_id, row.step_key)
            .map(rowToStepExecution),
    };
}

function rowToStepExecution(row) {
    return {
        executionId: row.execution_id,
        workflowId: row.workflow_id,
        stepKey: row.step_key,
        attempt: row.attempt,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at || undefined,
    };
}

function rowToWorkflow(row, includeSteps = true) {
    if (!row) return null;
    return {
        workflowId: row.workflow_id,
        characterId: row.character_id,
        roomId: row.room_id,
        ownerClientId: row.owner_client_id,
        ownerEpoch: row.owner_epoch,
        planVersion: row.plan_version,
        context: row.context ? JSON.parse(row.context) : undefined,
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

function listReadyChatWorkflowJobs(limit = 20) {
    return stmtListReadyChatWorkflowJobs
        .all(Math.max(1, Math.min(100, Number(limit) || 20)))
        .map(row => getGenerationJob(row.job_id, false))
        .filter(Boolean);
}

function claimGenerationWorkflowStep(workflowId, stepKey, expectedStatus = 'pending') {
    const now = Date.now();
    if (stmtClaimWorkflowStep.run(
        now,
        now,
        workflowId,
        stepKey,
        expectedStatus,
        workflowId,
    ).changes !== 1) return null;
    return getGenerationWorkflow(workflowId);
}

function parseStepMetadata(row) {
    if (!row?.metadata) return {};
    try {
        const metadata = JSON.parse(row.metadata);
        return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? metadata
            : {};
    } catch {
        return {};
    }
}

function claimGenerationWorkflowClientAction(
    workflowId,
    stepKey,
    actionId,
    clientId,
    leaseMs = CLIENT_ACTION_LEASE_MS,
) {
    return db.transaction(() => {
        const workflow = stmtGetWorkflow.get(workflowId);
        const row = stmtGetWorkflowStep.get(workflowId, stepKey);
        if (!workflow || workflow.status !== 'active' || row?.status !== 'waiting_client') return null;
        const metadata = parseStepMetadata(row);
        if (metadata.action?.actionId !== actionId) return null;
        const now = Date.now();
        const current = metadata.clientClaim;
        if (
            current?.clientId
            && current.clientId !== clientId
            && Number(current.expiresAt) > now
        ) {
            return { busy: true, action: metadata.action, claim: current };
        }
        const claim = {
            clientId,
            claimedAt: now,
            expiresAt: now + Math.max(1000, Number(leaseMs) || CLIENT_ACTION_LEASE_MS),
        };
        metadata.clientClaim = claim;
        stmtUpdateWorkflowStep.run(
            'waiting_client', JSON.stringify(metadata), 'waiting_client', now,
            'waiting_client', now, now, workflowId, stepKey,
        );
        stmtTouchWorkflow.run(now, workflowId);
        return { busy: false, action: metadata.action, claim };
    })();
}

function hasGenerationWorkflowClientActionClaim(
    workflowId,
    stepKey,
    actionId,
    clientId,
) {
    const workflow = stmtGetWorkflow.get(workflowId);
    const row = stmtGetWorkflowStep.get(workflowId, stepKey);
    if (!workflow || workflow.status !== 'active' || row?.status !== 'waiting_client') return false;
    const metadata = parseStepMetadata(row);
    return metadata.action?.actionId === actionId
        && metadata.clientClaim?.clientId === clientId;
}

function resolveGenerationWorkflowClientAction(
    workflowId,
    stepKey,
    actionId,
    clientId,
    response,
) {
    return db.transaction(() => {
        const workflow = stmtGetWorkflow.get(workflowId);
        const row = stmtGetWorkflowStep.get(workflowId, stepKey);
        if (!workflow || workflow.status !== 'active' || !row) return null;
        const metadata = parseStepMetadata(row);
        if (Object.prototype.hasOwnProperty.call(metadata.responses || {}, actionId)) {
            return { alreadyResolved: true };
        }
        if (row.status !== 'waiting_client' || metadata.action?.actionId !== actionId) return null;
        const now = Date.now();
        const claim = metadata.clientClaim;
        if (!claim?.clientId || claim.clientId !== clientId) {
            return { staleClaim: true, action: metadata.action, claim };
        }
        const responses = { ...(metadata.responses || {}), [actionId]: structuredClone(response) };
        const nextMetadata = { schemaVersion: 1, responses };
        stmtUpdateWorkflowStep.run(
            'pending', JSON.stringify(nextMetadata), 'pending', now,
            'pending', now, now, workflowId, stepKey,
        );
        stmtTouchWorkflow.run(now, workflowId);
        return { alreadyResolved: false };
    })();
}

function consumeGenerationWorkflowClientActionJobs(workflowId, actionId) {
    const stepKey = `client-action:${actionId}`.slice(0, 128);
    let consumed = 0;
    for (const job of listGenerationWorkflowJobs(workflowId)) {
        if (
            job.workflowStepKey === stepKey
            && !['queued', 'generating'].includes(job.status)
            && !job.materializedAt
            && markGenerationMaterialized(job.jobId)
        ) consumed += 1;
    }
    return consumed;
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
                input.context ? JSON.stringify(input.context) : null,
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

function claimGenerationWorkflow(
    workflowId,
    ownerClientId,
    expectedOwnerClientId,
    expectedOwnerEpoch,
) {
    const now = Date.now();
    const result = stmtClaimWorkflow.run(
        ownerClientId,
        now,
        workflowId,
        expectedOwnerClientId,
        expectedOwnerEpoch,
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
                update.metadata ? JSON.stringify(update.metadata) : null,
                ['running', 'waiting_client', 'waiting_job'].includes(update.status) ? now : null,
                terminal ? now : null,
                now,
            );
        } else {
            const metadata = update.metadata ? JSON.stringify(update.metadata) : null;
            stmtUpdateWorkflowStep.run(
                update.status,
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
    let changed = false;
    db.transaction(() => {
        changed = stmtFinishWorkflow.run(status, now, now, workflowId).changes === 1;
        if (changed) stmtCancelQueuedWorkflowExecutions.run(now, now, workflowId);
    })();
    return changed;
}

function cancelGenerationWorkflow(workflowId, terminalStatus = 'cancelled') {
    if (!['cancelled', 'failed'].includes(terminalStatus)) {
        throw new Error(`Invalid workflow cancellation status: ${terminalStatus}`);
    }
    const workflow = stmtGetWorkflow.get(workflowId);
    if (!workflow || workflow.status !== 'active') {
        return { changed: false, jobs: [] };
    }
    const jobs = stmtListActiveWorkflowJobs.all(workflowId).map(row => ({
        jobId: row.job_id,
        status: row.status,
    }));
    const now = Date.now();
    const finishReason = terminalStatus === 'cancelled'
        ? 'workflow_cancelled'
        : 'workflow_failed';
    db.transaction(() => {
        stmtFinishWorkflow.run(terminalStatus, now, now, workflowId);
        // A terminal workflow is intentionally discarded by the client. Mark
        // every child output acknowledged so reconnect recovery cannot replay
        // an already-finished child, while rows and journals remain retained.
        stmtAcknowledgeWorkflowJobs.run(now, workflowId);
        stmtCancelWorkflowJobs.run(finishReason, now, now, workflowId);
        stmtCancelWorkflowExecutions.run(finishReason, now, now, workflowId);
        stmtFailActiveWorkflowSteps.run(now, now, workflowId);
        stmtFailActiveStepExecutions.run(now, now, workflowId);
    })();
    return { changed: true, jobs };
}

function cancelGenerationStepExecution(workflowId, executionId) {
    const workflow = stmtGetWorkflow.get(workflowId);
    const execution = stmtGetStepExecution.get(executionId);
    if (
        !workflow
        || workflow.status !== 'active'
        || !execution
        || execution.workflow_id !== workflowId
    ) return { changed: false, jobs: [] };
    if (['completed', 'skipped', 'failed'].includes(execution.status)) {
        return { changed: false, jobs: [] };
    }
    const jobs = stmtListActiveStepExecutionJobs.all(workflowId, executionId).map(row => ({
        jobId: row.job_id,
        status: row.status,
    }));
    const now = Date.now();
    db.transaction(() => {
        stmtAcknowledgeStepExecutionJobs.run(now, now, workflowId, executionId);
        stmtCancelStepExecutionJobs.run(now, now, workflowId, executionId);
        stmtUpdateStepExecution.run('failed', 'failed', now, now, executionId);
        updateGenerationWorkflowStep(workflowId, execution.step_key, { status: 'failed' });
    })();
    return { changed: true, jobs, stepKey: execution.step_key };
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

function ensureGenerationStepExecution(input, status) {
    if (!input.workflowId) return undefined;
    const existing = stmtGetStepExecution.get(input.stepExecutionId);
    if (existing) {
        if (
            existing.workflow_id !== input.workflowId
            || existing.step_key !== input.workflowStepKey
        ) {
            const error = new Error('Step execution belongs to a different workflow step');
            error.httpStatus = 409;
            throw error;
        }
        stmtUpdateStepExecution.run(
            status,
            status,
            Date.now(),
            Date.now(),
            input.stepExecutionId,
        );
        return rowToStepExecution(stmtGetStepExecution.get(input.stepExecutionId));
    }
    const now = Date.now();
    stmtCreateStepExecution.run(
        input.stepExecutionId,
        input.workflowId,
        input.workflowStepKey,
        status,
        now,
        now,
        input.workflowId,
        input.workflowStepKey,
    );
    return rowToStepExecution(stmtGetStepExecution.get(input.stepExecutionId));
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
    ensureGenerationStepExecution(input, 'waiting_job');
    updateGenerationWorkflowStep(
        input.workflowId,
        input.workflowStepKey,
        { status: 'waiting_job' },
        {
            kind: input.jobType === 'model' ? 'model.main' : `job.${input.jobType}`,
            recoveryPolicy: 'replay_output',
        },
    );
}

function updateGenerationJobWorkflowStep(jobId, status) {
    const row = stmtGet.get(jobId);
    if (!row?.workflow_id || !row.workflow_step_key) return;
    if (row.step_execution_id) {
        ensureGenerationStepExecution({
            workflowId: row.workflow_id,
            workflowStepKey: row.workflow_step_key,
            stepExecutionId: row.step_execution_id,
        }, status);
    }
    updateGenerationWorkflowStep(
        row.workflow_id,
        row.workflow_step_key,
        { status },
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
        workflowStepExecutionId: row.step_execution_id || undefined,
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
        dispatchedAt: row.dispatched_at || undefined,
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
    if (input.workflowId && (!input.workflowStepKey || !input.stepExecutionId)) {
        const error = new Error('workflowStepKey and stepExecutionId are required when workflowId is set');
        error.httpStatus = 400;
        throw error;
    }
    generationJournalStore.create(input.workflowId || null, input.jobId);
    try {
        db.transaction(() => {
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
                stepExecutionId: input.stepExecutionId || null,
                adapterKind: typeof input.adapterKind === 'string' ? input.adapterKind.slice(0, 64) : null,
                streaming: input.streaming ? 1 : 0,
                dispatchGroup: input.dispatchGroup || null,
                dispatchMaxConcurrent: input.dispatchMaxConcurrent || null,
                dispatchRequestsPerMinute: input.dispatchRequestsPerMinute || null,
                requestSpec: input.requestSpec ? JSON.stringify(input.requestSpec) : null,
                now,
            });
            linkGenerationJobToWorkflow(input);
            if (input.workflowId && input.workflowStepKey) {
                // Tool loops and application retries can issue more than one
                // provider round for one logical step execution. The aggregate
                // step retains the latest job while the execution keeps the
                // complete one-to-many relationship.
                stmtAcknowledgeSupersededWorkflowStepJobs.run(
                    now,
                    now,
                    input.workflowId,
                    input.workflowStepKey,
                    input.jobId,
                );
            }
        })();
    } catch (error) {
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
    return {
        job: rowToJob({
            ...row,
            status: 'generating',
            request_spec: null,
            dispatched_at: now,
        }, false),
        requestSpec,
    };
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
    const rebuildingProjection = status === 'generated'
        && finishReason === 'projection_rebuilt'
        && job?.status === 'failed'
        && job?.finish_reason === 'projection_error';
    if (!['queued', 'generating'].includes(job?.status) && !rebuildingProjection) {
        // Cancellation can win while the provider stream is unwinding. Preserve
        // that terminal state, but reconcile the append-only journal length.
        if (job) stmtSetRawBytes.run(journalBytes, jobId);
        return false;
    }
    stmtFinish.run(status, finishReason || null, error || null, journalBytes, now, now, jobId);
    updateGenerationJobWorkflowStep(
        jobId,
        status === 'generated' ? 'output_ready' : 'failed',
    );
    return true;
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
                { status: 'completed' },
                { kind: 'message.materialize', recoveryPolicy: 'resume' },
            );
        }
    }
    return result.changes === 1;
}

function pruneRetainedGenerationJobs(retentionMs = GENERATION_RETENTION_MS) {
    const cutoff = Date.now() - Math.max(0, Number(retentionMs) || 0);
    const deletedJobs = [];
    db.transaction(() => {
        // Recoverable output is retained for one day even when a client never
        // returns to materialize/consume it. After that deadline, terminal jobs
        // and their journals are no longer useful and must not accumulate.
        for (const row of stmtExpiredTerminalJobs.all(cutoff)) {
            stmtDeleteJob.run(row.job_id);
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
        stmtDeleteCompletedStepExecutions.run(cutoff);
        stmtDeleteCompletedWorkflowSteps.run(cutoff);
        workflowsDeleted = stmtDeleteCompletedWorkflows.run(cutoff).changes;
    })();
    if (deletedJobs.length > 0) db.pragma('wal_checkpoint(PASSIVE)');
    return {
        deleted: deletedJobs.length,
        orphaned,
        workflowsDeleted,
        bytes: Number(stmtMaterializedPayloadTotal.get()?.total) || 0,
    };
}

function checkpointGenerationDb(mode = 'PASSIVE') {
    db.pragma(`wal_checkpoint(${mode})`);
}

module.exports = {
    createGenerationWorkflow,
    getGenerationWorkflow,
    getActiveGenerationWorkflow,
    listReadyChatWorkflowJobs,
    claimGenerationWorkflowStep,
    claimGenerationWorkflowClientAction,
    hasGenerationWorkflowClientActionClaim,
    resolveGenerationWorkflowClientAction,
    consumeGenerationWorkflowClientActionJobs,
    claimGenerationWorkflow,
    updateGenerationWorkflowStep,
    finishGenerationWorkflow,
    cancelGenerationWorkflow,
    cancelGenerationStepExecution,
    putGenerationWorkflowExecution,
    getGenerationWorkflowExecution,
    listQueuedGenerationWorkflowExecutions,
    claimGenerationWorkflowExecution,
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
    pruneRetainedGenerationJobs,
    checkpointGenerationDb,
};

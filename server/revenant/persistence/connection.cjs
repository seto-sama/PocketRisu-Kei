'use strict';

const Database = require('../../sqlite.cjs');
const path = require('path');
const fs = require('fs');
const { recoverInterruptedGenerationWork } = require('./restart.cjs');

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}

const revenantDir = path.join(saveDir, 'revenant');
fs.mkdirSync(revenantDir, { recursive: true });
const dbPath = path.join(revenantDir, 'revenant.db');
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
        generation_info TEXT,
        prompt_info TEXT,
        reroll_snapshot TEXT,
        operation_context TEXT,
        workflow_id TEXT,
        workflow_step_key TEXT,
        step_execution_id TEXT,
        adapter_kind TEXT,
        response_decoder TEXT,
        dispatch_group TEXT,
        dispatch_max_concurrent INTEGER,
        dispatched_at INTEGER,
        request_spec BLOB,
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
    CREATE TABLE IF NOT EXISTS workflowChatSnapshots (
        workflow_id TEXT PRIMARY KEY,
        input_chat TEXT NOT NULL
    );
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
if (!generationColumns.has('job_type')) {
    db.exec(`ALTER TABLE generation_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'model'`);
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
if (!generationColumns.has('response_decoder')) {
    // Journals written before requests carried their decoder were replayed
    // with the adapter defaults; keep them rebuildable the same way. One
    // transaction, so an interrupted startup cannot skip the backfill.
    db.transaction(() => {
        db.exec(`ALTER TABLE generation_jobs ADD COLUMN response_decoder TEXT`);
        db.exec(`
            UPDATE generation_jobs
            SET response_decoder = json_object(
                'adapterKind', CASE adapter_kind WHEN 'echo' THEN 'openai-compatible' ELSE adapter_kind END,
                'stream', json(CASE streaming WHEN 1 THEN 'true' ELSE 'false' END)
            )
            WHERE adapter_kind IN (
                'echo', 'openai-compatible', 'openai-responses',
                'anthropic-messages', 'google-gemini', 'amazon-bedrock'
            )
        `);
        db.exec(`ALTER TABLE generation_jobs DROP COLUMN streaming`);
    })();
}
if (generationColumns.has('processed_content')) {
    db.exec(`UPDATE generation_jobs SET processed_content = NULL WHERE processed_content IS NOT NULL`);
}
// Reconcile process-local claims while preserving durable queues, workflow
// snapshots, and completed journals for the new server process to resume.
const restartAt = Date.now();
recoverInterruptedGenerationWork(db, restartAt);
db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_active_main_room
    ON generation_jobs(character_id, room_id)
    WHERE job_type = 'model'
      AND character_id IS NOT NULL
      AND room_id IS NOT NULL
      AND status IN ('queued', 'generating')
`);

module.exports = { db };

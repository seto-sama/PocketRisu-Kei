'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { recoverInterruptedGenerationWork } = require('./restart.cjs');

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

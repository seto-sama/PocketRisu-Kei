import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import restartPkg from './generationRestart.cjs'

const { cancelActiveGenerationWork } = restartPkg as {
    cancelActiveGenerationWork: (db: Database.Database, now: number) => void
}

describe('generation database restart policy', () => {
    it('cancels active workflows and never resumes their queued provider work', () => {
        const db = new Database(':memory:')
        db.exec(`
            CREATE TABLE generation_workflows (
                workflow_id TEXT PRIMARY KEY, status TEXT,
                completed_at INTEGER, updated_at INTEGER
            );
            CREATE TABLE generation_workflow_steps (
                workflow_id TEXT, status TEXT,
                completed_at INTEGER, updated_at INTEGER
            );
            CREATE TABLE generation_workflow_executions (
                workflow_id TEXT, status TEXT, recipe TEXT, error TEXT,
                completed_at INTEGER, updated_at INTEGER
            );
            CREATE TABLE generation_jobs (
                job_id TEXT PRIMARY KEY, workflow_id TEXT, job_type TEXT,
                operation_context TEXT, status TEXT, finish_reason TEXT,
                request_spec TEXT, materialized_at INTEGER,
                completed_at INTEGER, updated_at INTEGER
            );
            INSERT INTO generation_workflows VALUES ('workflow-1', 'active', NULL, 1);
            INSERT INTO generation_workflow_steps VALUES ('workflow-1', 'waiting_job', NULL, 1);
            INSERT INTO generation_workflow_executions
                VALUES ('workflow-1', 'running', '{"secret":"recipe"}', NULL, NULL, 1);
            INSERT INTO generation_jobs
                VALUES ('job-1', 'workflow-1', 'memory', '{}', 'queued', NULL,
                    '{"targetUrl":"https://example.com"}', NULL, NULL, 1);
            INSERT INTO generation_jobs
                VALUES ('job-complete', 'workflow-1', 'memory', '{}', 'generated', 'provider_complete',
                    NULL, NULL, 10, 10);
            INSERT INTO generation_jobs
                VALUES ('standalone-1', NULL, 'memory', '{}', 'queued', NULL,
                    '{"targetUrl":"https://example.com"}', NULL, NULL, 1);
        `)

        cancelActiveGenerationWork(db, 123)

        expect(db.prepare(`SELECT status, completed_at FROM generation_workflows`).get())
            .toEqual({ status: 'cancelled', completed_at: 123 })
        expect(db.prepare(`SELECT status FROM generation_workflow_steps`).get())
            .toEqual({ status: 'failed' })
        expect(db.prepare(`SELECT status, recipe, error FROM generation_workflow_executions`).get())
            .toEqual({ status: 'failed', recipe: '{}', error: 'server_restart' })
        expect(db.prepare(`
            SELECT status, finish_reason, request_spec, materialized_at
            FROM generation_jobs WHERE job_id = 'job-1'
        `).get()).toEqual({
            status: 'cancelled',
            finish_reason: 'server_restart',
            request_spec: null,
            materialized_at: 123,
        })
        expect(db.prepare(`
            SELECT status, finish_reason, request_spec FROM generation_jobs WHERE job_id = 'standalone-1'
        `).get()).toEqual({
            status: 'interrupted',
            finish_reason: 'server_restart',
            request_spec: null,
        })
        expect(db.prepare(`
            SELECT status, finish_reason, materialized_at
            FROM generation_jobs WHERE job_id = 'job-complete'
        `).get()).toEqual({
            status: 'generated',
            finish_reason: 'provider_complete',
            materialized_at: 123,
        })
        db.close()
    })
})

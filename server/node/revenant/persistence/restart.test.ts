import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import restartPkg from './restart.cjs'

const { recoverInterruptedGenerationWork } = restartPkg as {
    recoverInterruptedGenerationWork: (db: Database.Database, now: number) => void
}

function createRestartDatabase() {
    const db = new Database(':memory:')
    db.exec(`
        CREATE TABLE generation_workflows (
            workflow_id TEXT PRIMARY KEY, status TEXT,
            completed_at INTEGER, updated_at INTEGER
        );
        CREATE TABLE generation_workflow_steps (
            workflow_id TEXT, step_key TEXT, kind TEXT, status TEXT, metadata TEXT,
            completed_at INTEGER, updated_at INTEGER
        );
        CREATE TABLE generation_workflow_step_executions (
            workflow_id TEXT, status TEXT,
            completed_at INTEGER, updated_at INTEGER
        );
        CREATE TABLE generation_workflow_executions (
            workflow_id TEXT, status TEXT, recipe TEXT, result TEXT, error TEXT,
            completed_at INTEGER, updated_at INTEGER
        );
        CREATE TABLE generation_jobs (
            job_id TEXT PRIMARY KEY, workflow_id TEXT, workflow_step_key TEXT,
            job_type TEXT, operation_context TEXT, status TEXT, finish_reason TEXT,
            request_spec TEXT, materialized_at INTEGER,
            completed_at INTEGER, updated_at INTEGER
        );
    `)
    return db
}

describe('generation database restart policy', () => {
    it('makes every unfinished workflow and job terminal instead of replaying work', () => {
        const db = createRestartDatabase()
        db.exec(`
            INSERT INTO generation_workflows VALUES
                ('workflow-1', 'active', NULL, 1),
                ('workflow-done', 'completed', 10, 10);
            INSERT INTO generation_workflow_steps VALUES
                ('workflow-1', 'image.generate', 'image.generate.server', 'running',
                    '{"action":{"actionId":"image-1"}}', NULL, 1),
                ('workflow-1', 'postprocess', 'postprocess.foreground', 'running', '{}', NULL, 1),
                ('workflow-done', 'done', 'message.materialize', 'completed', '{}', 10, 10);
            INSERT INTO generation_workflow_step_executions VALUES
                ('workflow-1', 'waiting_client', NULL, 1);
            INSERT INTO generation_workflow_executions VALUES
                ('workflow-1', 'running', '{"secret":"recipe"}', '{"partial":true}', NULL, NULL, 1);
            INSERT INTO generation_jobs VALUES
                ('job-running', 'workflow-1', 'model.main', 'model', '{}', 'generating', NULL,
                    '{"targetUrl":"https://example.com"}', NULL, NULL, 1),
                ('job-queued', 'workflow-1', 'memory', 'memory', '{}', 'queued', NULL,
                    '{"targetUrl":"https://example.com"}', NULL, NULL, 1),
                ('job-generated', 'workflow-1', 'model.main', 'model', '{}', 'generated',
                    'provider_complete', NULL, NULL, 10, 10),
                ('standalone-queued', NULL, NULL, 'memory', '{}', 'queued', NULL,
                    '{"targetUrl":"https://example.com"}', NULL, NULL, 1);
        `)

        recoverInterruptedGenerationWork(db, 123)

        expect(db.prepare(`
            SELECT workflow_id, status, completed_at FROM generation_workflows ORDER BY workflow_id
        `).all()).toEqual([
            { workflow_id: 'workflow-1', status: 'failed', completed_at: 123 },
            { workflow_id: 'workflow-done', status: 'completed', completed_at: 10 },
        ])
        const steps = db.prepare(`
            SELECT step_key, status, metadata FROM generation_workflow_steps
            WHERE workflow_id = 'workflow-1' ORDER BY step_key
        `).all() as Array<{ step_key: string, status: string, metadata: string }>
        expect(steps.map(step => ({
            stepKey: step.step_key,
            status: step.status,
            error: JSON.parse(step.metadata).error,
        }))).toEqual([
            { stepKey: 'image.generate', status: 'failed', error: 'Server restarted during active work' },
            { stepKey: 'postprocess', status: 'failed', error: 'Server restarted during active work' },
        ])
        expect(db.prepare(`SELECT status FROM generation_workflow_step_executions`).get())
            .toEqual({ status: 'failed' })
        expect(db.prepare(`SELECT status, recipe, result, error FROM generation_workflow_executions`).get())
            .toEqual({ status: 'failed', recipe: '{}', result: null, error: 'server_restart' })
        expect(db.prepare(`
            SELECT job_id, status, finish_reason, request_spec, materialized_at
            FROM generation_jobs ORDER BY job_id
        `).all()).toEqual([
            {
                job_id: 'job-generated', status: 'generated', finish_reason: 'provider_complete',
                request_spec: null, materialized_at: 123,
            },
            {
                job_id: 'job-queued', status: 'cancelled', finish_reason: 'server_restart',
                request_spec: null, materialized_at: 123,
            },
            {
                job_id: 'job-running', status: 'interrupted', finish_reason: 'server_restart',
                request_spec: null, materialized_at: 123,
            },
            {
                job_id: 'standalone-queued', status: 'cancelled', finish_reason: 'server_restart',
                request_spec: null, materialized_at: 123,
            },
        ])
        db.close()
    })
})

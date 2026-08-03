import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import restartPkg from './generationRestart.cjs'

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
    it('resumes durable queues, server postprocess, and waiting client actions', () => {
        const db = createRestartDatabase()
        db.exec(`
            INSERT INTO generation_workflows VALUES ('workflow-1', 'active', NULL, 1);
            INSERT INTO generation_workflow_steps VALUES
                ('workflow-1', 'output.transform', 'postprocess.output.transform', 'running',
                    '{"responses":{"lua":"ok"}}', NULL, 1),
                ('workflow-1', 'trigger.output', 'postprocess.trigger.output', 'waiting_client',
                    '{"action":{"actionId":"trigger.provider"},"clientClaim":{"clientId":"gone"}}', NULL, 1);
            INSERT INTO generation_workflow_executions VALUES
                ('workflow-1', 'running', '{"expectedOperationIds":[]}', NULL, NULL, NULL, 1);
            INSERT INTO generation_jobs VALUES
                ('job-queued', 'workflow-1', 'memory.hypav3', 'memory', '{}', 'queued', NULL,
                    '{"targetUrl":"https://example.com"}', NULL, NULL, 1),
                ('job-complete', 'workflow-1', 'model.main', 'model', '{}', 'generated',
                    'provider_complete', NULL, NULL, 10, 10),
                ('standalone-queued', NULL, NULL, 'memory', '{}', 'queued', NULL,
                    '{"targetUrl":"https://example.com"}', NULL, NULL, 1);
        `)

        recoverInterruptedGenerationWork(db, 123)

        expect(db.prepare(`SELECT status, completed_at FROM generation_workflows`).get())
            .toEqual({ status: 'active', completed_at: null })
        expect(db.prepare(`
            SELECT status, metadata FROM generation_workflow_steps
            WHERE step_key = 'output.transform'
        `).get()).toEqual({
            status: 'pending',
            metadata: '{"responses":{"lua":"ok"}}',
        })
        const waiting = db.prepare(`
            SELECT status, metadata FROM generation_workflow_steps
            WHERE step_key = 'trigger.output'
        `).get() as { status: string, metadata: string }
        expect(waiting.status).toBe('waiting_client')
        expect(JSON.parse(waiting.metadata)).toEqual({
            action: { actionId: 'trigger.provider' },
        })
        expect(db.prepare(`SELECT status, recipe FROM generation_workflow_executions`).get())
            .toEqual({ status: 'queued', recipe: '{"expectedOperationIds":[]}' })
        expect(db.prepare(`
            SELECT job_id, status, request_spec FROM generation_jobs
            WHERE job_id IN ('job-queued', 'standalone-queued') ORDER BY job_id
        `).all()).toEqual([
            {
                job_id: 'job-queued', status: 'queued',
                request_spec: '{"targetUrl":"https://example.com"}',
            },
            {
                job_id: 'standalone-queued', status: 'queued',
                request_spec: '{"targetUrl":"https://example.com"}',
            },
        ])
        expect(db.prepare(`
            SELECT status, finish_reason, materialized_at
            FROM generation_jobs WHERE job_id = 'job-complete'
        `).get()).toEqual({
            status: 'generated',
            finish_reason: 'provider_complete',
            materialized_at: null,
        })
        db.close()
    })

    it('interrupts an in-flight main request and closes only its workflow', () => {
        const db = createRestartDatabase()
        db.exec(`
            INSERT INTO generation_workflows VALUES
                ('workflow-failed', 'active', NULL, 1),
                ('workflow-pre-model', 'active', NULL, 1);
            INSERT INTO generation_workflow_steps VALUES
                ('workflow-failed', 'model.main', 'model.main', 'waiting_job', NULL, NULL, 1),
                ('workflow-failed', 'output.transform', 'postprocess.output.transform', 'pending', NULL, NULL, 1),
                ('workflow-pre-model', 'prompt.build', 'preprocess.prompt.build', 'running', NULL, NULL, 1);
            INSERT INTO generation_workflow_step_executions VALUES
                ('workflow-failed', 'waiting_job', NULL, 1);
            INSERT INTO generation_workflow_executions VALUES
                ('workflow-failed', 'queued', '{"secret":"recipe"}', NULL, NULL, NULL, 1);
            INSERT INTO generation_jobs VALUES
                ('job-main', 'workflow-failed', 'model.main', 'model', '{}', 'generating', NULL,
                    NULL, NULL, NULL, 1),
                ('job-later', 'workflow-failed', 'igp', 'memory', '{}', 'queued', NULL,
                    '{"targetUrl":"https://example.com"}', NULL, NULL, 1),
                ('standalone-running', NULL, NULL, 'memory', NULL, 'generating', NULL,
                    NULL, NULL, NULL, 1),
                ('standalone-invalid', NULL, NULL, 'memory', NULL, 'queued', NULL,
                    'not-json', NULL, NULL, 1);
        `)

        recoverInterruptedGenerationWork(db, 123)

        expect(db.prepare(`
            SELECT workflow_id, status, completed_at FROM generation_workflows ORDER BY workflow_id
        `).all()).toEqual([
            { workflow_id: 'workflow-failed', status: 'failed', completed_at: 123 },
            { workflow_id: 'workflow-pre-model', status: 'active', completed_at: null },
        ])
        const steps = db.prepare(`
            SELECT workflow_id, step_key, status, metadata
            FROM generation_workflow_steps ORDER BY workflow_id, step_key
        `).all() as Array<{ workflow_id: string, step_key: string, status: string, metadata: string | null }>
        expect(steps.slice(0, 2).map(step => ({
            workflow_id: step.workflow_id,
            step_key: step.step_key,
            status: step.status,
            error: JSON.parse(step.metadata!).error,
        }))).toEqual([
            {
                workflow_id: 'workflow-failed', step_key: 'model.main', status: 'failed',
                error: 'Server restarted during the model request',
            },
            {
                workflow_id: 'workflow-failed', step_key: 'output.transform', status: 'failed',
                error: 'Server restarted during the model request',
            },
        ])
        expect(steps[2]).toMatchObject({
            workflow_id: 'workflow-pre-model', step_key: 'prompt.build', status: 'running',
        })
        expect(db.prepare(`SELECT status, recipe, error FROM generation_workflow_executions`).get())
            .toEqual({ status: 'failed', recipe: '{}', error: 'server_restart' })
        expect(db.prepare(`SELECT status FROM generation_workflow_step_executions`).get())
            .toEqual({ status: 'failed' })
        expect(db.prepare(`
            SELECT job_id, status, finish_reason, request_spec, materialized_at
            FROM generation_jobs ORDER BY job_id
        `).all()).toEqual([
            {
                job_id: 'job-later', status: 'cancelled', finish_reason: 'workflow_failed',
                request_spec: null, materialized_at: 123,
            },
            {
                job_id: 'job-main', status: 'interrupted', finish_reason: 'server_restart',
                request_spec: null, materialized_at: 123,
            },
            {
                job_id: 'standalone-invalid', status: 'interrupted', finish_reason: 'server_restart',
                request_spec: null, materialized_at: null,
            },
            {
                job_id: 'standalone-running', status: 'interrupted', finish_reason: 'server_restart',
                request_spec: null, materialized_at: 123,
            },
        ])
        db.close()
    })
})

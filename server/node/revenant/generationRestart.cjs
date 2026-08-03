'use strict';

const RESTART_ERROR = 'Server restarted during the model request';

function recoverInterruptedGenerationWork(db, restartAt = Date.now()) {
    db.transaction(() => {
        // A request that reached `generating` already consumed its durable
        // envelope and owned a process-local upstream socket. Its journal is
        // retained, but that request cannot be dispatched a second time.
        db.prepare(`
            UPDATE generation_jobs
            SET status = 'interrupted',
                finish_reason = COALESCE(finish_reason, 'server_restart'),
                request_spec = NULL,
                materialized_at = CASE
                    WHEN workflow_id IS NULL
                      AND job_type <> 'model'
                      AND operation_context IS NULL
                        THEN COALESCE(materialized_at, ?)
                    ELSE materialized_at
                END,
                completed_at = COALESCE(completed_at, ?),
                updated_at = ?
            WHERE status = 'generating'
        `).run(restartAt, restartAt, restartAt);

        // A valid queued envelope has not contacted the provider yet and is
        // safe to resume. Only malformed/incomplete queue entries are terminal.
        db.prepare(`
            UPDATE generation_jobs
            SET status = 'interrupted', finish_reason = 'server_restart',
                request_spec = NULL,
                completed_at = COALESCE(completed_at, ?), updated_at = ?
            WHERE status = 'queued'
              AND (request_spec IS NULL OR json_valid(request_spec) = 0)
        `).run(restartAt, restartAt);

        const interruptedMainWorkflow = `
            status = 'active'
            AND EXISTS (
                SELECT 1 FROM generation_jobs
                WHERE generation_jobs.workflow_id = generation_workflows.workflow_id
                  AND generation_jobs.job_type = 'model'
                  AND generation_jobs.workflow_step_key = 'model.main'
                  AND generation_jobs.status IN (
                      'interrupted', 'cancelled', 'failed', 'failed_partial'
                  )
            )
        `;

        // The main provider socket cannot be replayed safely. Close only those
        // workflows; pre-model work and workflows with a generated projection
        // remain recoverable.
        db.prepare(`
            UPDATE generation_workflow_executions
            SET status = 'failed', recipe = '{}', error = 'server_restart',
                completed_at = ?, updated_at = ?
            WHERE status IN ('queued', 'running')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows
                  WHERE ${interruptedMainWorkflow}
              )
        `).run(restartAt, restartAt);
        db.prepare(`
            UPDATE generation_workflow_steps
            SET status = 'failed',
                metadata = json_patch(
                    CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                    json_object('schemaVersion', 1, 'error', ?)
                ),
                completed_at = ?, updated_at = ?
            WHERE status NOT IN ('completed', 'skipped', 'failed')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows
                  WHERE ${interruptedMainWorkflow}
              )
        `).run(RESTART_ERROR, restartAt, restartAt);
        db.prepare(`
            UPDATE generation_workflow_step_executions
            SET status = 'failed', completed_at = ?, updated_at = ?
            WHERE status NOT IN ('completed', 'skipped', 'failed')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows
                  WHERE ${interruptedMainWorkflow}
              )
        `).run(restartAt, restartAt);
        db.prepare(`
            UPDATE generation_jobs
            SET status = 'cancelled', finish_reason = 'workflow_failed',
                request_spec = NULL,
                completed_at = COALESCE(completed_at, ?), updated_at = ?
            WHERE status = 'queued'
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows
                  WHERE ${interruptedMainWorkflow}
              )
        `).run(restartAt, restartAt);
        db.prepare(`
            UPDATE generation_jobs
            SET materialized_at = COALESCE(materialized_at, ?), updated_at = ?
            WHERE workflow_id IN (
                SELECT workflow_id FROM generation_workflows
                WHERE ${interruptedMainWorkflow}
            )
        `).run(restartAt, restartAt);
        db.prepare(`
            UPDATE generation_workflows
            SET status = 'failed', completed_at = ?, updated_at = ?
            WHERE ${interruptedMainWorkflow}
        `).run(restartAt, restartAt);

        // Server-owned transforms operate on an immutable workflow snapshot.
        // Replaying a step that was only process-locally `running` is therefore
        // deterministic; completed steps and client responses stay untouched.
        db.prepare(`
            UPDATE generation_workflow_steps
            SET status = 'pending', completed_at = NULL, updated_at = ?
            WHERE status = 'running'
              AND (kind LIKE 'postprocess.%' OR kind = 'message.materialize')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `).run(restartAt);

        // waiting_client describes the workflow boundary, while clientClaim is
        // only a lease held by one live connection. No connection survives a
        // server restart, so make the same action immediately claimable again.
        db.prepare(`
            UPDATE generation_workflow_steps
            SET metadata = json_remove(metadata, '$.clientClaim'), updated_at = ?
            WHERE status = 'waiting_client'
              AND json_valid(metadata)
              AND json_type(metadata, '$.clientClaim') IS NOT NULL
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `).run(restartAt);

        // Hypa selection is a server computation whose complete recipe is
        // durable. A process-local running claim can safely return to its queue.
        db.prepare(`
            UPDATE generation_workflow_executions
            SET status = 'queued', result = NULL, error = NULL,
                completed_at = NULL, updated_at = ?
            WHERE status = 'running'
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `).run(restartAt);

        // Defensive cleanup: terminal workflows must never leave a durable
        // provider envelope available to the global dispatch queue.
        db.prepare(`
            UPDATE generation_jobs
            SET status = 'cancelled', finish_reason = 'workflow_completed',
                request_spec = NULL,
                completed_at = COALESCE(completed_at, ?), updated_at = ?
            WHERE status = 'queued'
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status <> 'active'
              )
        `).run(restartAt, restartAt);
    })();
}

module.exports = { recoverInterruptedGenerationWork };

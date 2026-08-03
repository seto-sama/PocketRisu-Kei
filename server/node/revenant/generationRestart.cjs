'use strict';

function cancelActiveGenerationWork(db, restartAt = Date.now()) {
    db.transaction(() => {
        db.prepare(`
            UPDATE generation_jobs
            SET materialized_at = COALESCE(materialized_at, ?)
            WHERE workflow_id IN (
                SELECT workflow_id FROM generation_workflows WHERE status = 'active'
            )
        `).run(restartAt);
        db.prepare(`
            UPDATE generation_jobs
            SET status = 'cancelled', finish_reason = 'server_restart',
                request_spec = NULL,
                completed_at = ?, updated_at = ?
            WHERE status IN ('queued', 'generating')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `).run(restartAt, restartAt);
        db.prepare(`
            UPDATE generation_workflow_executions
            SET status = 'failed', recipe = '{}', error = 'server_restart',
                completed_at = ?, updated_at = ?
            WHERE status IN ('queued', 'running')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `).run(restartAt, restartAt);
        db.prepare(`
            UPDATE generation_workflow_steps
            SET status = 'failed', completed_at = ?, updated_at = ?
            WHERE status NOT IN ('completed', 'skipped', 'failed')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `).run(restartAt, restartAt);
        db.prepare(`
            UPDATE generation_workflow_step_executions
            SET status = 'failed', completed_at = ?, updated_at = ?
            WHERE status NOT IN ('completed', 'skipped', 'failed')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `).run(restartAt, restartAt);
        db.prepare(`
            UPDATE generation_workflows
            SET status = 'cancelled', completed_at = ?, updated_at = ?
            WHERE status = 'active'
        `).run(restartAt, restartAt);

        // Standalone jobs also lost their upstream socket. Retain any partial
        // journal, but clear the request envelope so it can never be retried.
        db.prepare(`
            UPDATE generation_jobs
            SET status = 'interrupted',
                finish_reason = COALESCE(finish_reason, 'server_restart'),
                request_spec = NULL,
                materialized_at = CASE
                    WHEN job_type <> 'model' AND operation_context IS NULL
                        THEN COALESCE(materialized_at, ?)
                    ELSE materialized_at
                END,
                completed_at = COALESCE(completed_at, ?),
                updated_at = ?
            WHERE status IN ('queued', 'generating')
        `).run(restartAt, restartAt, restartAt);
    })();
}

module.exports = { cancelActiveGenerationWork };

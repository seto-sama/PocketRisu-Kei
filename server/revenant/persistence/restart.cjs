'use strict';

const RESTART_ERROR = 'Server restarted during active work';

/**
 * Browser reloads may reconnect to Revenant, but a server process restart is
 * a hard execution boundary. Provider sockets, client-action leases, and
 * process-local executors cannot be replayed without risking duplicate work.
 */
function recoverInterruptedGenerationWork(db, restartAt = Date.now()) {
    db.transaction(() => {
        db.prepare(`
            UPDATE generation_jobs
            SET status = CASE
                    WHEN status = 'generating' THEN 'interrupted'
                    WHEN status = 'queued' THEN 'cancelled'
                    ELSE status
                END,
                finish_reason = CASE
                    WHEN status IN ('queued', 'generating')
                        THEN COALESCE(finish_reason, 'server_restart')
                    ELSE finish_reason
                END,
                request_spec = CASE
                    WHEN status IN ('queued', 'generating') THEN NULL
                    ELSE request_spec
                END,
                completed_at = CASE
                    WHEN status IN ('queued', 'generating')
                        THEN COALESCE(completed_at, ?)
                    ELSE completed_at
                END,
                materialized_at = COALESCE(materialized_at, ?),
                updated_at = ?
            WHERE materialized_at IS NULL OR status IN ('queued', 'generating')
        `).run(restartAt, restartAt, restartAt);

        db.prepare(`
            UPDATE generation_workflow_steps
            SET status = 'failed',
                metadata = json_patch(
                    CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                    json_object('schemaVersion', 1, 'error', ?)
                ),
                completed_at = COALESCE(completed_at, ?),
                updated_at = ?
            WHERE status NOT IN ('completed', 'skipped', 'failed')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `).run(RESTART_ERROR, restartAt, restartAt);

        db.prepare(`
            UPDATE generation_workflow_step_executions
            SET status = 'failed', completed_at = COALESCE(completed_at, ?), updated_at = ?
            WHERE status NOT IN ('completed', 'skipped', 'failed')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `).run(restartAt, restartAt);

        db.prepare(`
            UPDATE generation_workflow_executions
            SET status = 'failed', recipe = '{}', result = NULL,
                error = 'server_restart', completed_at = COALESCE(completed_at, ?), updated_at = ?
            WHERE status IN ('queued', 'running')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `).run(restartAt, restartAt);

        db.prepare(`
            UPDATE generation_workflows
            SET status = 'failed', completed_at = COALESCE(completed_at, ?), updated_at = ?
            WHERE status = 'active'
        `).run(restartAt, restartAt);
    })();
}

module.exports = { recoverInterruptedGenerationWork };

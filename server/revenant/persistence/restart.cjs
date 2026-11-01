'use strict';

const { withTransaction } = require('../../sqlite.cjs');
const RESTART_ERROR = 'Server restarted during active work';

/**
 * Browser reloads may reconnect to Revenant, but a server process restart is
 * a hard execution boundary. Provider sockets, client-action leases, and
 * process-local executors cannot be replayed without risking duplicate work.
 */
function recoverInterruptedGenerationWork(db, restartAt = Date.now()) {
    const sql = db.createTagStore();
    withTransaction(db, () => {
        sql.run`
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
                        THEN COALESCE(completed_at, ${restartAt})
                    ELSE completed_at
                END,
                materialized_at = COALESCE(materialized_at, ${restartAt}),
                updated_at = ${restartAt}
            WHERE materialized_at IS NULL OR status IN ('queued', 'generating')
        `;

        sql.run`
            UPDATE generation_workflow_steps
            SET status = 'failed',
                metadata = json_patch(
                    CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                    json_object('schemaVersion', 1, 'error', ${RESTART_ERROR})
                ),
                completed_at = COALESCE(completed_at, ${restartAt}),
                updated_at = ${restartAt}
            WHERE status NOT IN ('completed', 'skipped', 'failed')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `;

        sql.run`
            UPDATE generation_workflow_step_executions
            SET status = 'failed', completed_at = COALESCE(completed_at, ${restartAt}), updated_at = ${restartAt}
            WHERE status NOT IN ('completed', 'skipped', 'failed')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `;

        sql.run`
            UPDATE generation_workflow_executions
            SET status = 'failed', recipe = '{}', result = NULL,
                error = 'server_restart', completed_at = COALESCE(completed_at, ${restartAt}), updated_at = ${restartAt}
            WHERE status IN ('queued', 'running')
              AND workflow_id IN (
                  SELECT workflow_id FROM generation_workflows WHERE status = 'active'
              )
        `;

        sql.run`
            UPDATE generation_workflows
            SET status = 'failed', completed_at = COALESCE(completed_at, ${restartAt}), updated_at = ${restartAt}
            WHERE status = 'active'
        `;
    });
}

module.exports = { recoverInterruptedGenerationWork };

'use strict';

function createGenerationStatements(db) {
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
            workflow_id, character_id, room_id,
            plan_version, context, status, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, 'active', ?, ?)
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
    const stmtGetLatestWorkflowForRoom = db.prepare(`
        SELECT * FROM generation_workflows
        WHERE character_id = ? AND room_id = ?
        ORDER BY created_at DESC
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
    const stmtAcknowledgeCancelledWorkflowJobs = db.prepare(`
        UPDATE generation_jobs
        SET materialized_at = COALESCE(materialized_at, ?)
        WHERE workflow_id = ? AND COALESCE(job_type, 'model') <> 'model'
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

    return {
        stmtCreate,
        stmtGet,
        stmtSetGenerating,
        stmtSetHeaders,
        stmtFinish,
        stmtSetProjection,
        stmtSetClientProjection,
        stmtSetProjectionError,
        stmtUpdateMetadata,
        stmtListRecoverable,
        stmtListRecoverableAuxiliary,
        stmtListNeedingProjection,
        stmtListQueuedDispatches,
        stmtDispatchState,
        stmtClaimDispatch,
        stmtMarkMaterialized,
        stmtAcknowledgeSupersededWorkflowStepJobs,
        stmtMaterializedPayloadTotal,
        stmtDeleteJob,
        stmtAllJobIds,
        stmtSetRawBytes,
        stmtExpiredTerminalJobs,
        stmtCreateWorkflow,
        stmtCreateWorkflowStep,
        stmtGetWorkflow,
        stmtGetActiveWorkflowForRoom,
        stmtGetLatestWorkflowForRoom,
        stmtListWorkflowSteps,
        stmtGetWorkflowStep,
        stmtListReadyChatWorkflowJobs,
        stmtClaimWorkflowStep,
        stmtGetStepExecution,
        stmtListStepExecutions,
        stmtCreateStepExecution,
        stmtUpdateStepExecution,
        stmtNextWorkflowStepOrder,
        stmtInsertDynamicWorkflowStep,
        stmtUpdateWorkflowStep,
        stmtTouchWorkflow,
        stmtFinishWorkflow,
        stmtCancelWorkflowExecutions,
        stmtCancelQueuedWorkflowExecutions,
        stmtListActiveWorkflowJobs,
        stmtListActiveStepExecutionJobs,
        stmtAcknowledgeStepExecutionJobs,
        stmtCancelStepExecutionJobs,
        stmtAcknowledgeWorkflowJobs,
        stmtAcknowledgeCancelledWorkflowJobs,
        stmtCancelWorkflowJobs,
        stmtFailActiveWorkflowSteps,
        stmtFailActiveStepExecutions,
        stmtDeleteCompletedStepExecutions,
        stmtDeleteCompletedWorkflowSteps,
        stmtDeleteCompletedWorkflows,
        stmtPutWorkflowExecution,
        stmtGetWorkflowExecution,
        stmtListQueuedWorkflowExecutions,
        stmtClaimWorkflowExecution,
        stmtFinishWorkflowExecution,
        stmtListWorkflowJobs,
        stmtDeleteCompletedWorkflowExecutions,
    };
}

module.exports = { createGenerationStatements };

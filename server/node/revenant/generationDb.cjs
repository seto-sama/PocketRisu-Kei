'use strict';

const { generationJournalStore } = require('./generationJournal.cjs');
const { db } = require('./generationDbConnection.cjs');
const { createGenerationStatements } = require('./generationDbStatements.cjs');

const GENERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLIENT_ACTION_LEASE_MS = 5 * 60 * 1000;

const {
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
} = createGenerationStatements(db);

// A process may stop after file append but before the terminal metadata update.
// The append-only file is authoritative, so reconcile its length on boot.
db.transaction(() => {
    for (const row of stmtAllJobIds.all()) {
        stmtSetRawBytes.run(
            generationJournalStore.size(row.workflow_id, row.job_id),
            row.job_id,
        );
    }
})();

function rowToWorkflowStep(row) {
    return {
        key: row.step_key,
        order: row.step_order,
        kind: row.kind,
        recoveryPolicy: row.recovery_policy,
        status: row.status,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        startedAt: row.started_at || undefined,
        completedAt: row.completed_at || undefined,
        updatedAt: row.updated_at,
        executions: stmtListStepExecutions
            .all(row.workflow_id, row.step_key)
            .map(rowToStepExecution),
    };
}

function rowToStepExecution(row) {
    return {
        executionId: row.execution_id,
        workflowId: row.workflow_id,
        stepKey: row.step_key,
        attempt: row.attempt,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at || undefined,
    };
}

function rowToWorkflow(row, includeSteps = true) {
    if (!row) return null;
    return {
        workflowId: row.workflow_id,
        characterId: row.character_id,
        roomId: row.room_id,
        planVersion: row.plan_version,
        context: row.context ? JSON.parse(row.context) : undefined,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at || undefined,
        ...(includeSteps
            ? { steps: stmtListWorkflowSteps.all(row.workflow_id).map(rowToWorkflowStep) }
            : {}),
    };
}

function getGenerationWorkflow(workflowId, includeSteps = true) {
    return rowToWorkflow(stmtGetWorkflow.get(workflowId), includeSteps);
}

function getActiveGenerationWorkflow(characterId, roomId, includeSteps = true) {
    return rowToWorkflow(
        stmtGetActiveWorkflowForRoom.get(characterId, roomId),
        includeSteps,
    );
}

function listReadyChatWorkflowJobs(limit = 20) {
    return stmtListReadyChatWorkflowJobs
        .all(Math.max(1, Math.min(100, Number(limit) || 20)))
        .map(row => getGenerationJob(row.job_id, false))
        .filter(Boolean);
}

function claimGenerationWorkflowStep(workflowId, stepKey, expectedStatus = 'pending') {
    const now = Date.now();
    if (stmtClaimWorkflowStep.run(
        now,
        now,
        workflowId,
        stepKey,
        expectedStatus,
        workflowId,
    ).changes !== 1) return null;
    return getGenerationWorkflow(workflowId);
}

function parseStepMetadata(row) {
    if (!row?.metadata) return {};
    try {
        const metadata = JSON.parse(row.metadata);
        return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? metadata
            : {};
    } catch {
        return {};
    }
}

function claimGenerationWorkflowClientAction(
    workflowId,
    stepKey,
    actionId,
    clientId,
    leaseMs = CLIENT_ACTION_LEASE_MS,
) {
    return db.transaction(() => {
        const workflow = stmtGetWorkflow.get(workflowId);
        const row = stmtGetWorkflowStep.get(workflowId, stepKey);
        if (!workflow || workflow.status !== 'active' || row?.status !== 'waiting_client') return null;
        const metadata = parseStepMetadata(row);
        if (metadata.action?.actionId !== actionId) return null;
        const now = Date.now();
        const current = metadata.clientClaim;
        if (
            current?.clientId
            && current.clientId !== clientId
            && Number(current.expiresAt) > now
        ) {
            return { busy: true, action: metadata.action, claim: current };
        }
        const claim = {
            clientId,
            claimedAt: now,
            expiresAt: now + Math.max(1000, Number(leaseMs) || CLIENT_ACTION_LEASE_MS),
        };
        metadata.clientClaim = claim;
        stmtUpdateWorkflowStep.run(
            'waiting_client', JSON.stringify(metadata), 'waiting_client', now,
            'waiting_client', now, now, workflowId, stepKey,
        );
        stmtTouchWorkflow.run(now, workflowId);
        return { busy: false, action: metadata.action, claim };
    })();
}

function hasGenerationWorkflowClientActionClaim(
    workflowId,
    stepKey,
    actionId,
    clientId,
) {
    const workflow = stmtGetWorkflow.get(workflowId);
    const row = stmtGetWorkflowStep.get(workflowId, stepKey);
    if (!workflow || workflow.status !== 'active' || row?.status !== 'waiting_client') return false;
    const metadata = parseStepMetadata(row);
    return metadata.action?.actionId === actionId
        && metadata.clientClaim?.clientId === clientId;
}

function resolveGenerationWorkflowClientAction(
    workflowId,
    stepKey,
    actionId,
    clientId,
    response,
) {
    return db.transaction(() => {
        const workflow = stmtGetWorkflow.get(workflowId);
        const row = stmtGetWorkflowStep.get(workflowId, stepKey);
        if (!workflow || workflow.status !== 'active' || !row) return null;
        const metadata = parseStepMetadata(row);
        if (Object.prototype.hasOwnProperty.call(metadata.responses || {}, actionId)) {
            return { alreadyResolved: true };
        }
        if (row.status !== 'waiting_client' || metadata.action?.actionId !== actionId) return null;
        const now = Date.now();
        const claim = metadata.clientClaim;
        if (!claim?.clientId || claim.clientId !== clientId) {
            return { staleClaim: true, action: metadata.action, claim };
        }
        const responses = { ...(metadata.responses || {}), [actionId]: structuredClone(response) };
        const nextMetadata = { schemaVersion: 1, responses };
        stmtUpdateWorkflowStep.run(
            'pending', JSON.stringify(nextMetadata), 'pending', now,
            'pending', now, now, workflowId, stepKey,
        );
        stmtTouchWorkflow.run(now, workflowId);
        return { alreadyResolved: false };
    })();
}

function consumeGenerationWorkflowClientActionJobs(workflowId, actionId) {
    const stepKey = `client-action:${actionId}`.slice(0, 128);
    let consumed = 0;
    for (const job of listGenerationWorkflowJobs(workflowId)) {
        if (
            job.workflowStepKey === stepKey
            && !['queued', 'generating'].includes(job.status)
            && !job.materializedAt
            && markGenerationMaterialized(job.jobId)
        ) consumed += 1;
    }
    return consumed;
}

function createGenerationWorkflow(input) {
    const now = Date.now();
    try {
        db.transaction(() => {
            stmtCreateWorkflow.run(
                input.workflowId,
                input.characterId,
                input.roomId,
                input.context ? JSON.stringify(input.context) : null,
                now,
                now,
            );
            for (const step of input.plan) {
                stmtCreateWorkflowStep.run({
                    workflowId: input.workflowId,
                    ...step,
                    metadata: step.metadata ? JSON.stringify(step.metadata) : null,
                    now,
                });
            }
        })();
    } catch (error) {
        if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return {
                busy: true,
                workflow: getActiveGenerationWorkflow(input.characterId, input.roomId),
            };
        }
        throw error;
    }
    return { busy: false, workflow: getGenerationWorkflow(input.workflowId) };
}

function updateGenerationWorkflowStep(
    workflowId,
    stepKey,
    update,
    dynamic = undefined,
) {
    const workflow = stmtGetWorkflow.get(workflowId);
    if (!workflow || workflow.status !== 'active') return false;
    const now = Date.now();
    db.transaction(() => {
        if (!stmtGetWorkflowStep.get(workflowId, stepKey)) {
            if (!dynamic) throw new Error(`Unknown generation workflow step: ${stepKey}`);
            const terminal = ['completed', 'skipped', 'failed'].includes(update.status);
            stmtInsertDynamicWorkflowStep.run(
                workflowId,
                stepKey,
                stmtNextWorkflowStepOrder.get(workflowId).next_order,
                dynamic.kind,
                dynamic.recoveryPolicy,
                update.status,
                update.metadata ? JSON.stringify(update.metadata) : null,
                ['running', 'waiting_client', 'waiting_job'].includes(update.status) ? now : null,
                terminal ? now : null,
                now,
            );
        } else {
            const metadata = update.metadata ? JSON.stringify(update.metadata) : null;
            stmtUpdateWorkflowStep.run(
                update.status,
                metadata,
                update.status,
                now,
                update.status,
                now,
                now,
                workflowId,
                stepKey,
            );
        }
        stmtTouchWorkflow.run(now, workflowId);
    })();
    return true;
}

function finishGenerationWorkflow(workflowId, status) {
    const now = Date.now();
    let changed = false;
    db.transaction(() => {
        changed = stmtFinishWorkflow.run(status, now, now, workflowId).changes === 1;
        if (changed) stmtCancelQueuedWorkflowExecutions.run(now, now, workflowId);
    })();
    return changed;
}

function cancelGenerationWorkflow(workflowId, terminalStatus = 'cancelled') {
    if (!['cancelled', 'failed'].includes(terminalStatus)) {
        throw new Error(`Invalid workflow cancellation status: ${terminalStatus}`);
    }
    const workflow = stmtGetWorkflow.get(workflowId);
    if (!workflow || workflow.status !== 'active') {
        return { changed: false, jobs: [] };
    }
    const jobs = stmtListActiveWorkflowJobs.all(workflowId).map(row => ({
        jobId: row.job_id,
        status: row.status,
    }));
    const now = Date.now();
    const finishReason = terminalStatus === 'cancelled'
        ? 'workflow_cancelled'
        : 'workflow_failed';
    db.transaction(() => {
        stmtFinishWorkflow.run(terminalStatus, now, now, workflowId);
        // A terminal workflow is intentionally discarded by the client. Mark
        // every child output acknowledged so reconnect recovery cannot replay
        // an already-finished child, while rows and journals remain retained.
        stmtAcknowledgeWorkflowJobs.run(now, workflowId);
        stmtCancelWorkflowJobs.run(finishReason, now, now, workflowId);
        stmtCancelWorkflowExecutions.run(finishReason, now, now, workflowId);
        stmtFailActiveWorkflowSteps.run(now, now, workflowId);
        stmtFailActiveStepExecutions.run(now, now, workflowId);
    })();
    return { changed: true, jobs };
}

function cancelGenerationStepExecution(workflowId, executionId) {
    const workflow = stmtGetWorkflow.get(workflowId);
    const execution = stmtGetStepExecution.get(executionId);
    if (
        !workflow
        || workflow.status !== 'active'
        || !execution
        || execution.workflow_id !== workflowId
    ) return { changed: false, jobs: [] };
    if (['completed', 'skipped', 'failed'].includes(execution.status)) {
        return { changed: false, jobs: [] };
    }
    const jobs = stmtListActiveStepExecutionJobs.all(workflowId, executionId).map(row => ({
        jobId: row.job_id,
        status: row.status,
    }));
    const now = Date.now();
    db.transaction(() => {
        stmtAcknowledgeStepExecutionJobs.run(now, now, workflowId, executionId);
        stmtCancelStepExecutionJobs.run(now, now, workflowId, executionId);
        stmtUpdateStepExecution.run('failed', 'failed', now, now, executionId);
        updateGenerationWorkflowStep(workflowId, execution.step_key, { status: 'failed' });
    })();
    return { changed: true, jobs, stepKey: execution.step_key };
}

function rowToWorkflowExecution(row, includeRecipe = false) {
    if (!row) return null;
    return {
        workflowId: row.workflow_id,
        kind: row.execution_kind,
        status: row.status,
        ...(includeRecipe ? { recipe: JSON.parse(row.recipe) } : {}),
        result: row.result ? JSON.parse(row.result) : undefined,
        error: row.error || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at || undefined,
    };
}

function putGenerationWorkflowExecution(workflowId, kind, recipe) {
    const workflow = stmtGetWorkflow.get(workflowId);
    if (!workflow || workflow.status !== 'active') return null;
    const now = Date.now();
    stmtPutWorkflowExecution.run(workflowId, kind, JSON.stringify(recipe), now, now);
    return rowToWorkflowExecution(stmtGetWorkflowExecution.get(workflowId));
}

function getGenerationWorkflowExecution(workflowId, includeRecipe = false) {
    return rowToWorkflowExecution(stmtGetWorkflowExecution.get(workflowId), includeRecipe);
}

function listQueuedGenerationWorkflowExecutions(limit = 20) {
    return stmtListQueuedWorkflowExecutions
        .all(Math.max(1, Math.min(100, Number(limit) || 20)))
        .map(row => rowToWorkflowExecution(row, true));
}

function claimGenerationWorkflowExecution(workflowId) {
    const now = Date.now();
    if (stmtClaimWorkflowExecution.run(now, workflowId).changes !== 1) return null;
    return getGenerationWorkflowExecution(workflowId, true);
}

function finishGenerationWorkflowExecution(workflowId, status, result, error) {
    const now = Date.now();
    return stmtFinishWorkflowExecution.run(
        status,
        result ? JSON.stringify(result) : null,
        error || null,
        now,
        now,
        workflowId,
    ).changes === 1;
}

function listGenerationWorkflowJobs(workflowId) {
    return stmtListWorkflowJobs.all(workflowId).map(row => rowToJob(row, false));
}

function ensureGenerationStepExecution(input, status) {
    if (!input.workflowId) return undefined;
    const existing = stmtGetStepExecution.get(input.stepExecutionId);
    if (existing) {
        if (
            existing.workflow_id !== input.workflowId
            || existing.step_key !== input.workflowStepKey
        ) {
            const error = new Error('Step execution belongs to a different workflow step');
            error.httpStatus = 409;
            throw error;
        }
        stmtUpdateStepExecution.run(
            status,
            status,
            Date.now(),
            Date.now(),
            input.stepExecutionId,
        );
        return rowToStepExecution(stmtGetStepExecution.get(input.stepExecutionId));
    }
    const now = Date.now();
    stmtCreateStepExecution.run(
        input.stepExecutionId,
        input.workflowId,
        input.workflowStepKey,
        status,
        now,
        now,
        input.workflowId,
        input.workflowStepKey,
    );
    return rowToStepExecution(stmtGetStepExecution.get(input.stepExecutionId));
}

function linkGenerationJobToWorkflow(input) {
    if (!input.workflowId) return;
    const workflow = stmtGetWorkflow.get(input.workflowId);
    if (
        !workflow
        || workflow.status !== 'active'
        || workflow.character_id !== input.characterId
        || workflow.room_id !== input.roomId
    ) {
        const error = new Error('Generation workflow is not active for this room');
        error.httpStatus = 409;
        throw error;
    }
    ensureGenerationStepExecution(input, 'waiting_job');
    updateGenerationWorkflowStep(
        input.workflowId,
        input.workflowStepKey,
        { status: 'waiting_job' },
        {
            kind: input.jobType === 'model' ? 'model.main' : `job.${input.jobType}`,
            recoveryPolicy: 'replay_output',
        },
    );
}

function updateGenerationJobWorkflowStep(jobId, status) {
    const row = stmtGet.get(jobId);
    if (!row?.workflow_id || !row.workflow_step_key) return;
    if (row.step_execution_id) {
        ensureGenerationStepExecution({
            workflowId: row.workflow_id,
            workflowStepKey: row.workflow_step_key,
            stepExecutionId: row.step_execution_id,
        }, status);
    }
    updateGenerationWorkflowStep(
        row.workflow_id,
        row.workflow_step_key,
        { status },
        {
            kind: row.job_type === 'model' ? 'model.main' : `job.${row.job_type}`,
            recoveryPolicy: 'replay_output',
        },
    );
}

function rowToJob(row, includeRaw = true) {
    if (!row) return null;
    const rawResponse = includeRaw
        ? generationJournalStore.readAll(row.workflow_id, row.job_id)
        : undefined;
    const rawBytes = rawResponse?.length ?? Math.max(0, Number(row.raw_bytes) || 0);
    return {
        jobId: row.job_id,
        chatId: row.chat_id,
        jobType: row.job_type || 'model',
        characterId: row.character_id,
        roomId: row.room_id,
        isContinuation: row.is_continuation === 1,
        continuationPrefix: row.continuation_prefix || '',
        generationInfo: row.generation_info ? JSON.parse(row.generation_info) : undefined,
        promptInfo: row.prompt_info ? JSON.parse(row.prompt_info) : undefined,
        rerollSnapshot: row.reroll_snapshot ? JSON.parse(row.reroll_snapshot) : undefined,
        operationContext: row.operation_context ? JSON.parse(row.operation_context) : undefined,
        workflowId: row.workflow_id || undefined,
        workflowStepKey: row.workflow_step_key || undefined,
        workflowStepExecutionId: row.step_execution_id || undefined,
        adapterKind: row.adapter_kind || undefined,
        streaming: row.streaming === 1,
        status: row.status,
        responseStatus: row.response_status,
        responseHeaders: row.response_headers ? JSON.parse(row.response_headers) : {},
        ...(includeRaw
            ? { rawResponse, rawBytes }
            : { rawBytes }),
        projection: parseNormalizedProjection(row.normalized_projection),
        projectionError: row.projection_error || undefined,
        projectedAt: row.projected_at || undefined,
        finishReason: row.finish_reason,
        error: row.error,
        dispatchedAt: row.dispatched_at || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        materializedAt: row.materialized_at,
    };
}

function parseNormalizedProjection(value) {
    if (!value) return undefined;
    try {
        const projection = JSON.parse(value);
        if (
            projection?.schemaVersion !== 1
            || !['server', 'client'].includes(projection.source)
            || typeof projection.adapterKind !== 'string'
            || typeof projection.content !== 'string'
        ) return undefined;
        return projection;
    } catch {
        return undefined;
    }
}

function createGenerationJob(input) {
    const now = Date.now();
    const activeWorkflow = input.characterId && input.roomId
        ? stmtGetActiveWorkflowForRoom.get(input.characterId, input.roomId)
        : null;
    if (activeWorkflow && activeWorkflow.workflow_id !== input.workflowId) {
        const error = new Error('A generation workflow is already active for this room');
        error.httpStatus = 409;
        error.workflowId = activeWorkflow.workflow_id;
        throw error;
    }
    if (input.workflowId && (!input.workflowStepKey || !input.stepExecutionId)) {
        const error = new Error('workflowStepKey and stepExecutionId are required when workflowId is set');
        error.httpStatus = 400;
        throw error;
    }
    generationJournalStore.create(input.workflowId || null, input.jobId);
    try {
        db.transaction(() => {
            stmtCreate.run({
                jobId: input.jobId,
                chatId: input.chatId || null,
                jobType: input.jobType || 'model',
                characterId: input.characterId || null,
                roomId: input.roomId || null,
                isContinuation: input.isContinuation ? 1 : 0,
                continuationPrefix: input.continuationPrefix || null,
                generationInfo: input.generationInfo ? JSON.stringify(input.generationInfo) : null,
                promptInfo: input.promptInfo ? JSON.stringify(input.promptInfo) : null,
                rerollSnapshot: input.rerollSnapshot ? JSON.stringify(input.rerollSnapshot) : null,
                operationContext: input.operationContext ? JSON.stringify(input.operationContext) : null,
                workflowId: input.workflowId || null,
                workflowStepKey: input.workflowStepKey || null,
                stepExecutionId: input.stepExecutionId || null,
                adapterKind: typeof input.adapterKind === 'string' ? input.adapterKind.slice(0, 64) : null,
                streaming: input.streaming ? 1 : 0,
                dispatchGroup: input.dispatchGroup || null,
                dispatchMaxConcurrent: input.dispatchMaxConcurrent || null,
                dispatchRequestsPerMinute: input.dispatchRequestsPerMinute || null,
                requestSpec: input.requestSpec ? JSON.stringify(input.requestSpec) : null,
                now,
            });
            linkGenerationJobToWorkflow(input);
            if (input.workflowId && input.workflowStepKey) {
                // Tool loops and application retries can issue more than one
                // provider round for one logical step execution. The aggregate
                // step retains the latest job while the execution keeps the
                // complete one-to-many relationship.
                stmtAcknowledgeSupersededWorkflowStepJobs.run(
                    now,
                    now,
                    input.workflowId,
                    input.workflowStepKey,
                    input.jobId,
                );
            }
        })();
    } catch (error) {
        generationJournalStore.remove(input.workflowId || null, input.jobId);
        throw error;
    }
    return getGenerationJob(input.jobId);
}

function getGenerationJob(jobId, includeRaw = true) {
    return rowToJob(stmtGet.get(jobId), includeRaw);
}

function setGenerationJobGenerating(jobId) {
    const now = Date.now();
    stmtSetGenerating.run(now, now, jobId);
    updateGenerationJobWorkflowStep(jobId, 'waiting_job');
}

function listQueuedGenerationDispatches(limit = 500) {
    const normalized = Math.max(1, Math.min(1000, Number(limit) || 500));
    return stmtListQueuedDispatches.all(normalized).map(row => ({
        job: rowToJob(row, false),
        dispatchGroup: row.dispatch_group,
        maxConcurrent: Math.max(1, Number(row.dispatch_max_concurrent) || 1),
        requestsPerMinute: Math.max(1, Number(row.dispatch_requests_per_minute) || 1),
        requestSpec: JSON.parse(row.request_spec),
    }));
}

function getGenerationDispatchState(dispatchGroup, since) {
    const row = stmtDispatchState.get(since, since, dispatchGroup);
    return {
        active: Math.max(0, Number(row?.active) || 0),
        recent: Math.max(0, Number(row?.recent) || 0),
        oldestRecent: row?.oldest_recent || undefined,
    };
}

function claimQueuedGenerationDispatch(jobId) {
    const row = stmtGet.get(jobId);
    if (!row?.request_spec || row.status !== 'queued') return undefined;
    const requestSpec = JSON.parse(row.request_spec);
    const now = Date.now();
    const result = stmtClaimDispatch.run(now, now, jobId);
    if (result.changes !== 1) return undefined;
    updateGenerationJobWorkflowStep(jobId, 'waiting_job');
    return {
        job: rowToJob({
            ...row,
            status: 'generating',
            request_spec: null,
            dispatched_at: now,
        }, false),
        requestSpec,
    };
}

function setGenerationJobHeaders(jobId, status, headers) {
    stmtSetHeaders.run(status, JSON.stringify(headers || {}), Date.now(), jobId);
}

function finishGenerationJob(jobId, status, finishReason, error = null, rawBytes) {
    const now = Date.now();
    const job = stmtGet.get(jobId);
    const journalBytes = Number.isSafeInteger(rawBytes) && rawBytes >= 0
        ? rawBytes
        : generationJournalStore.size(job?.workflow_id, jobId);
    const rebuildingProjection = status === 'generated'
        && finishReason === 'projection_rebuilt'
        && job?.status === 'failed'
        && job?.finish_reason === 'projection_error';
    if (!['queued', 'generating'].includes(job?.status) && !rebuildingProjection) {
        // Cancellation can win while the provider stream is unwinding. Preserve
        // that terminal state, but reconcile the append-only journal length.
        if (job) stmtSetRawBytes.run(journalBytes, jobId);
        return false;
    }
    stmtFinish.run(status, finishReason || null, error || null, journalBytes, now, now, jobId);
    updateGenerationJobWorkflowStep(
        jobId,
        status === 'generated' ? 'output_ready' : 'failed',
    );
    if (job?.job_type === 'model' && job.workflow_id && status !== 'generated') {
        const terminalStatus = status === 'cancelled' ? 'cancelled' : 'failed';
        updateGenerationWorkflowStep(job.workflow_id, 'model.main', {
            status: 'failed',
            metadata: {
                schemaVersion: 1,
                error: String(error || finishReason || `Model generation ended as ${status}`),
            },
        });
        cancelGenerationWorkflow(job.workflow_id, terminalStatus);
    }
    return true;
}

function readGenerationJobRaw(jobId) {
    const job = stmtGet.get(jobId);
    return generationJournalStore.readAll(job?.workflow_id, jobId);
}

function setGenerationJobProjection(jobId, projection) {
    const now = Date.now();
    const result = stmtSetProjection.run(JSON.stringify(projection), now, now, jobId);
    return result.changes === 1;
}

function setGenerationJobClientProjection(jobId, projection) {
    const now = Date.now();
    const result = stmtSetClientProjection.run(JSON.stringify(projection), now, now, jobId);
    return result.changes === 1;
}

function setGenerationJobProjectionError(jobId, error) {
    const result = stmtSetProjectionError.run(String(error ?? ''), Date.now(), jobId);
    return result.changes === 1;
}

function updateGenerationJobMetadata(jobId, generationInfo, promptInfo) {
    const result = stmtUpdateMetadata.run(
        generationInfo ? JSON.stringify(generationInfo) : null,
        promptInfo ? JSON.stringify(promptInfo) : null,
        Date.now(),
        jobId,
    );
    return result.changes === 1;
}

function listRecoverableGenerationJobs(limit = 50) {
    const normalized = Math.max(1, Math.min(200, Number(limit) || 50));
    return stmtListRecoverable.all(normalized).map(row => rowToJob(row, false));
}

function listRecoverableAuxiliaryJobs(limit = 200) {
    const normalized = Math.max(1, Math.min(500, Number(limit) || 200));
    return stmtListRecoverableAuxiliary.all(normalized).map(row => rowToJob(row, false));
}

function listGenerationJobsNeedingProjection(limit = 200, schemaVersion = 1) {
    const normalized = Math.max(1, Math.min(500, Number(limit) || 200));
    return stmtListNeedingProjection
        .all(Number(schemaVersion) || 1, normalized)
        .map(row => rowToJob(row, false));
}

function markGenerationMaterialized(jobId) {
    const job = stmtGet.get(jobId);
    const result = stmtMarkMaterialized.run(Date.now(), Date.now(), jobId);
    if (result.changes === 1) {
        updateGenerationJobWorkflowStep(
            jobId,
            job?.job_type !== 'model' && job?.status !== 'generated'
                ? 'failed'
                : 'completed',
        );
        if (job?.job_type === 'model' && job.workflow_id) {
            updateGenerationWorkflowStep(
                job.workflow_id,
                'message.materialize',
                { status: 'completed' },
                { kind: 'message.materialize', recoveryPolicy: 'resume' },
            );
        }
    }
    return result.changes === 1;
}

function pruneRetainedGenerationJobs(retentionMs = GENERATION_RETENTION_MS) {
    const cutoff = Date.now() - Math.max(0, Number(retentionMs) || 0);
    const deletedJobs = [];
    db.transaction(() => {
        // Recoverable output is retained for one day even when a client never
        // returns to materialize/consume it. After that deadline, terminal jobs
        // and their journals are no longer useful and must not accumulate.
        for (const row of stmtExpiredTerminalJobs.all(cutoff)) {
            stmtDeleteJob.run(row.job_id);
            deletedJobs.push({ jobId: row.job_id, workflowId: row.workflow_id });
        }
    })();
    for (const job of deletedJobs) {
        generationJournalStore.remove(job.workflowId, job.jobId);
    }
    const validJournals = new Set(stmtAllJobIds.all().map(row =>
        generationJournalStore.journalKey(row.workflow_id, row.job_id)));
    const orphaned = generationJournalStore.removeOrphans(validJournals, cutoff);
    let workflowsDeleted = 0;
    db.transaction(() => {
        stmtDeleteCompletedWorkflowExecutions.run(cutoff);
        stmtDeleteCompletedStepExecutions.run(cutoff);
        stmtDeleteCompletedWorkflowSteps.run(cutoff);
        workflowsDeleted = stmtDeleteCompletedWorkflows.run(cutoff).changes;
    })();
    if (deletedJobs.length > 0) db.pragma('wal_checkpoint(PASSIVE)');
    return {
        deleted: deletedJobs.length,
        orphaned,
        workflowsDeleted,
        bytes: Number(stmtMaterializedPayloadTotal.get()?.total) || 0,
    };
}

function checkpointGenerationDb(mode = 'PASSIVE') {
    db.pragma(`wal_checkpoint(${mode})`);
}

module.exports = {
    createGenerationWorkflow,
    getGenerationWorkflow,
    getActiveGenerationWorkflow,
    listReadyChatWorkflowJobs,
    claimGenerationWorkflowStep,
    claimGenerationWorkflowClientAction,
    hasGenerationWorkflowClientActionClaim,
    resolveGenerationWorkflowClientAction,
    consumeGenerationWorkflowClientActionJobs,
    updateGenerationWorkflowStep,
    finishGenerationWorkflow,
    cancelGenerationWorkflow,
    cancelGenerationStepExecution,
    putGenerationWorkflowExecution,
    getGenerationWorkflowExecution,
    listQueuedGenerationWorkflowExecutions,
    claimGenerationWorkflowExecution,
    finishGenerationWorkflowExecution,
    listGenerationWorkflowJobs,
    createGenerationJob,
    getGenerationJob,
    setGenerationJobGenerating,
    listQueuedGenerationDispatches,
    getGenerationDispatchState,
    claimQueuedGenerationDispatch,
    setGenerationJobHeaders,
    readGenerationJobRaw,
    setGenerationJobProjection,
    setGenerationJobClientProjection,
    setGenerationJobProjectionError,
    updateGenerationJobMetadata,
    finishGenerationJob,
    listRecoverableGenerationJobs,
    listRecoverableAuxiliaryJobs,
    listGenerationJobsNeedingProjection,
    markGenerationMaterialized,
    pruneRetainedGenerationJobs,
    checkpointGenerationDb,
};

'use strict';

const { isUniqueConstraintError, withTransaction } = require('../../sqlite.cjs');
const { encodeGenerationRequest, decodeGenerationRequest } = require('../protocol.cjs');
const { generationJournalStore } = require('../generationJournal.cjs');
const { db } = require('./connection.cjs');
const {
    REVENANT_CAPACITY,
    createWorkflowCapacityError,
} = require('../capacity.cjs');

const GENERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLIENT_ACTION_LEASE_MS = 5 * 60 * 1000;

const sql = db.createTagStore();
const jsonOrNull = value => (value ? JSON.stringify(value) : null);
const getJobRow = jobId => sql.get`SELECT * FROM generation_jobs WHERE job_id = ${jobId}`;
const allJobIds = () => sql.all`SELECT job_id, workflow_id FROM generation_jobs`;
const setRawBytes = (rawBytes, jobId) => sql.run`UPDATE generation_jobs SET raw_bytes = ${rawBytes} WHERE job_id = ${jobId}`;
const getWorkflowRow = workflowId => sql.get`SELECT * FROM generation_workflows WHERE workflow_id = ${workflowId}`;
const getActiveWorkflowRow = (characterId, roomId) => sql.get`
    SELECT * FROM generation_workflows
    WHERE character_id = ${characterId} AND room_id = ${roomId} AND status = 'active'
    LIMIT 1
`;
const getWorkflowStepRow = (workflowId, stepKey) => sql.get`
    SELECT * FROM generation_workflow_steps WHERE workflow_id = ${workflowId} AND step_key = ${stepKey}
`;
const getStepExecutionRow = executionId => sql.get`
    SELECT * FROM generation_workflow_step_executions WHERE execution_id = ${executionId}
`;
const updateStepExecution = (status, now, executionId) => sql.run`
    UPDATE generation_workflow_step_executions
    SET status = ${status},
        completed_at = CASE
            WHEN ${status} IN ('completed', 'skipped', 'failed') THEN ${now}
            ELSE NULL
        END,
        updated_at = ${now}
    WHERE execution_id = ${executionId}
`;
const updateWorkflowStep = (status, metadata, now, workflowId, stepKey) => sql.run`
    UPDATE generation_workflow_steps
    SET status = ${status}, metadata = COALESCE(${metadata}, metadata),
        started_at = CASE
            WHEN ${status} IN ('running', 'waiting_client', 'waiting_job') THEN COALESCE(started_at, ${now})
            ELSE started_at
        END,
        completed_at = CASE
            WHEN ${status} IN ('completed', 'skipped', 'failed') THEN ${now}
            ELSE NULL
        END,
        updated_at = ${now}
    WHERE workflow_id = ${workflowId} AND step_key = ${stepKey}
`;
const touchWorkflow = (now, workflowId) => sql.run`
    UPDATE generation_workflows SET updated_at = ${now} WHERE workflow_id = ${workflowId} AND status = 'active'
`;
const finishWorkflow = (status, now, workflowId) => sql.run`
    UPDATE generation_workflows
    SET status = ${status}, completed_at = ${now}, updated_at = ${now}
    WHERE workflow_id = ${workflowId} AND status = 'active'
`;
const getWorkflowExecutionRow = workflowId => sql.get`
    SELECT * FROM generation_workflow_executions WHERE workflow_id = ${workflowId}
`;

// A process may stop after file append but before the terminal metadata update.
// The append-only file is authoritative, so reconcile its length on boot.
withTransaction(db, () => {
    for (const row of allJobIds()) {
        setRawBytes(generationJournalStore.size(row.workflow_id, row.job_id), row.job_id);
    }
});

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
        executions: sql.all`
            SELECT * FROM generation_workflow_step_executions
            WHERE workflow_id = ${row.workflow_id} AND step_key = ${row.step_key}
            ORDER BY attempt ASC
        `
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
            ? { steps: sql.all`
                SELECT * FROM generation_workflow_steps
                WHERE workflow_id = ${row.workflow_id}
                ORDER BY step_order ASC
            `.map(rowToWorkflowStep) }
            : {}),
    };
}

function getGenerationWorkflowInputChat(workflowId) {
    const snapshot = sql.get`
        SELECT input_chat FROM workflowChatSnapshots WHERE workflow_id = ${workflowId}
    `;
    return snapshot?.input_chat ? JSON.parse(snapshot.input_chat) : undefined;
}

function getGenerationWorkflow(workflowId, includeSteps = true) {
    return rowToWorkflow(getWorkflowRow(workflowId), includeSteps);
}

function getActiveGenerationWorkflow(characterId, roomId, includeSteps = true) {
    return rowToWorkflow(
        getActiveWorkflowRow(characterId, roomId),
        includeSteps,
    );
}

function listReadyChatWorkflowJobs(limit = 20) {
    return sql.all`
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
          AND COALESCE(json_extract(normalized_projection, '$.awaitingProviderResult'), 0) <> 1
          AND materialized_at IS NULL
        ORDER BY completed_at ASC, created_at ASC
        LIMIT ${Math.max(1, Math.min(100, Number(limit) || 20))}
    `
        .map(row => getGenerationJob(row.job_id, false));
}

function claimGenerationWorkflowStep(workflowId, stepKey, expectedStatus = 'pending') {
    const now = Date.now();
    if (sql.run`
        UPDATE generation_workflow_steps
        SET status = 'running', started_at = COALESCE(started_at, ${now}), updated_at = ${now}
        WHERE workflow_id = ${workflowId} AND step_key = ${stepKey} AND status = ${expectedStatus}
          AND EXISTS (
              SELECT 1 FROM generation_workflows
              WHERE workflow_id = ${workflowId} AND status = 'active'
          )
    `.changes !== 1) return null;
    return getGenerationWorkflow(workflowId);
}

function parseStepMetadata(row) {
    return row?.metadata ? JSON.parse(row.metadata) : {};
}

function claimGenerationWorkflowClientAction(
    workflowId,
    stepKey,
    actionId,
    clientId,
    leaseMs = CLIENT_ACTION_LEASE_MS,
    isClientConnected,
) {
    return withTransaction(db, () => {
        const workflow = getWorkflowRow(workflowId);
        const row = getWorkflowStepRow(workflowId, stepKey);
        if (!workflow || workflow.status !== 'active' || row?.status !== 'waiting_client') return null;
        const metadata = parseStepMetadata(row);
        if (metadata.action?.actionId !== actionId) return null;
        const now = Date.now();
        const current = metadata.clientClaim;
        // The lease protects a genuinely connected page from parallel side
        // effects. A page-scoped client id disappears on refresh, though, so a
        // disconnected owner must not keep the claim until the lease timeout.
        // Callers without connection state retain the conservative lease-only
        // behavior used by offline repository consumers and tests.
        const currentOwnerConnected = typeof isClientConnected === 'function'
            ? isClientConnected(String(current?.clientId || ''))
            : true;
        if (
            current?.clientId
            && current.clientId !== clientId
            && Number(current.expiresAt) > now
            && currentOwnerConnected
        ) {
            return { busy: true, action: metadata.action, claim: current };
        }
        const claim = {
            clientId,
            claimedAt: now,
            expiresAt: now + Math.max(1000, Number(leaseMs) || CLIENT_ACTION_LEASE_MS),
        };
        metadata.clientClaim = claim;
        updateWorkflowStep('waiting_client', JSON.stringify(metadata), now, workflowId, stepKey);
        touchWorkflow(now, workflowId);
        return { busy: false, action: metadata.action, claim };
    });
}

function hasGenerationWorkflowClientActionClaim(
    workflowId,
    stepKey,
    actionId,
    clientId,
) {
    const workflow = getWorkflowRow(workflowId);
    const row = getWorkflowStepRow(workflowId, stepKey);
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
    return withTransaction(db, () => {
        const workflow = getWorkflowRow(workflowId);
        const row = getWorkflowStepRow(workflowId, stepKey);
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
        updateWorkflowStep('pending', JSON.stringify(nextMetadata), now, workflowId, stepKey);
        touchWorkflow(now, workflowId);
        return { alreadyResolved: false };
    });
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
    const inputChat = input.context?.inputCommit?.chat;
    let context = input.context;
    if (inputChat) {
        const { inputCommit: _inputCommit, ...workflowContext } = input.context;
        context = workflowContext;
    }
    let activeWorkflowId;
    try {
        withTransaction(db, () => {
            const activeWorkflow = getActiveWorkflowRow(input.characterId, input.roomId);
            if (activeWorkflow) {
                activeWorkflowId = activeWorkflow.workflow_id;
                return;
            }
            const activeCount = Number(sql.get`
                SELECT COUNT(*) AS count FROM generation_workflows WHERE status = 'active'
            `?.count) || 0;
            if (activeCount >= REVENANT_CAPACITY.maxActiveWorkflows) {
                throw createWorkflowCapacityError();
            }
            sql.run`
                INSERT INTO generation_workflows (
                    workflow_id, character_id, room_id,
                    plan_version, context, status, created_at, updated_at
                ) VALUES (
                    ${input.workflowId}, ${input.characterId}, ${input.roomId},
                    1, ${jsonOrNull(context)}, 'active', ${now}, ${now}
                )
            `;
            if (inputChat) {
                sql.run`
                    INSERT INTO workflowChatSnapshots (workflow_id, input_chat)
                    VALUES (${input.workflowId}, ${JSON.stringify(inputChat)})
                `;
            }
            for (const step of input.plan) {
                sql.run`
                    INSERT INTO generation_workflow_steps (
                        workflow_id, step_key, step_order, kind, recovery_policy,
                        status, metadata, started_at, completed_at, updated_at
                    ) VALUES (
                        ${input.workflowId}, ${step.key}, ${step.order}, ${step.kind}, ${step.recoveryPolicy},
                        ${step.status}, ${jsonOrNull(step.metadata)},
                        CASE WHEN ${step.status} = 'completed' THEN ${now} ELSE NULL END,
                        CASE WHEN ${step.status} IN ('completed', 'skipped') THEN ${now} ELSE NULL END,
                        ${now}
                    )
                `;
            }
        });
    } catch (error) {
        if (isUniqueConstraintError(error)) {
            return {
                busy: true,
                workflow: getActiveGenerationWorkflow(input.characterId, input.roomId),
            };
        }
        throw error;
    }
    if (activeWorkflowId) {
        return {
            busy: true,
            workflow: getGenerationWorkflow(activeWorkflowId),
        };
    }
    return { busy: false, workflow: getGenerationWorkflow(input.workflowId) };
}

function updateGenerationWorkflowStep(
    workflowId,
    stepKey,
    update,
    dynamic = undefined,
) {
    const workflow = getWorkflowRow(workflowId);
    if (!workflow || workflow.status !== 'active') return false;
    const now = Date.now();
    withTransaction(db, () => {
        if (!getWorkflowStepRow(workflowId, stepKey)) {
            if (!dynamic) throw new Error(`Unknown generation workflow step: ${stepKey}`);
            const terminal = ['completed', 'skipped', 'failed'].includes(update.status);
            const startedAt = ['running', 'waiting_client', 'waiting_job'].includes(update.status) ? now : null;
            sql.run`
                INSERT INTO generation_workflow_steps (
                    workflow_id, step_key, step_order, kind, recovery_policy,
                    status, metadata, started_at, completed_at, updated_at
                )
                SELECT ${workflowId}, ${stepKey}, COALESCE(MAX(step_order), -1) + 1, ${dynamic.kind}, ${dynamic.recoveryPolicy},
                    ${update.status}, ${jsonOrNull(update.metadata)}, ${startedAt}, ${terminal ? now : null}, ${now}
                FROM generation_workflow_steps WHERE workflow_id = ${workflowId}
            `;
        } else {
            const metadata = update.metadata ? JSON.stringify(update.metadata) : null;
            updateWorkflowStep(update.status, metadata, now, workflowId, stepKey);
        }
        touchWorkflow(now, workflowId);
    });
    return true;
}

function finishGenerationWorkflow(workflowId, status) {
    const now = Date.now();
    let changed = false;
    withTransaction(db, () => {
        changed = finishWorkflow(status, now, workflowId).changes === 1;
        if (changed) sql.run`
            UPDATE generation_workflow_executions
            SET status = 'failed', recipe = '{}', error = 'workflow_completed',
                completed_at = ${now}, updated_at = ${now}
            WHERE workflow_id = ${workflowId} AND status = 'queued'
        `;
    });
    return changed;
}

function cancelGenerationWorkflow(workflowId, terminalStatus = 'cancelled') {
    if (!['cancelled', 'failed'].includes(terminalStatus)) {
        throw new Error(`Invalid workflow cancellation status: ${terminalStatus}`);
    }
    const workflow = getWorkflowRow(workflowId);
    if (!workflow || workflow.status !== 'active') {
        return { changed: false, jobs: [] };
    }
    const jobs = sql.all`
        SELECT job_id, status FROM generation_jobs
        WHERE workflow_id = ${workflowId} AND status IN ('queued', 'generating')
    `.map(row => ({
        jobId: row.job_id,
        status: row.status,
    }));
    const now = Date.now();
    const finishReason = terminalStatus === 'cancelled'
        ? 'workflow_cancelled'
        : 'workflow_failed';
    withTransaction(db, () => {
        finishWorkflow(terminalStatus, now, workflowId);
        // Failed workflows discard all child output. A user cancellation keeps
        // the model journal unacknowledged until the server materializer has
        // committed its partial projection; auxiliary children are discarded.
        if (terminalStatus === 'cancelled') {
            sql.run`
                UPDATE generation_jobs
                SET materialized_at = COALESCE(materialized_at, ${now})
                WHERE workflow_id = ${workflowId} AND COALESCE(job_type, 'model') <> 'model'
            `;
        } else {
            sql.run`
                UPDATE generation_jobs
                SET materialized_at = COALESCE(materialized_at, ${now})
                WHERE workflow_id = ${workflowId}
            `;
        }
        sql.run`
            UPDATE generation_jobs
            SET status = 'cancelled', finish_reason = ${finishReason}, error = NULL,
                request_spec = NULL,
                completed_at = ${now}, updated_at = ${now}
            WHERE workflow_id = ${workflowId} AND status IN ('queued', 'generating')
        `;
        sql.run`
            UPDATE generation_workflow_executions
            SET status = 'failed', recipe = '{}', error = ${finishReason},
                completed_at = ${now}, updated_at = ${now}
            WHERE workflow_id = ${workflowId} AND status IN ('queued', 'running')
        `;
        sql.run`
            UPDATE generation_workflow_steps
            SET status = 'failed', completed_at = ${now}, updated_at = ${now}
            WHERE workflow_id = ${workflowId}
              AND status NOT IN ('completed', 'skipped', 'failed')
        `;
        sql.run`
            UPDATE generation_workflow_step_executions
            SET status = 'failed', completed_at = ${now}, updated_at = ${now}
            WHERE workflow_id = ${workflowId}
              AND status NOT IN ('completed', 'skipped', 'failed')
        `;
    });
    return { changed: true, jobs };
}

function cancelGenerationStepExecution(workflowId, executionId) {
    const workflow = getWorkflowRow(workflowId);
    const execution = getStepExecutionRow(executionId);
    if (
        !workflow
        || workflow.status !== 'active'
        || !execution
        || execution.workflow_id !== workflowId
    ) return { changed: false, jobs: [] };
    if (['completed', 'skipped', 'failed'].includes(execution.status)) {
        return { changed: false, jobs: [] };
    }
    const jobs = sql.all`
        SELECT job_id, status FROM generation_jobs
        WHERE workflow_id = ${workflowId} AND step_execution_id = ${executionId}
          AND status IN ('queued', 'generating')
    `.map(row => ({
        jobId: row.job_id,
        status: row.status,
    }));
    const now = Date.now();
    withTransaction(db, () => {
        sql.run`
            UPDATE generation_jobs
            SET materialized_at = COALESCE(materialized_at, ${now}), updated_at = ${now}
            WHERE workflow_id = ${workflowId} AND step_execution_id = ${executionId}
        `;
        sql.run`
            UPDATE generation_jobs
            SET status = 'cancelled', finish_reason = 'step_cancelled', error = NULL,
                request_spec = NULL, completed_at = ${now}, updated_at = ${now}
            WHERE workflow_id = ${workflowId} AND step_execution_id = ${executionId}
              AND status IN ('queued', 'generating')
        `;
        updateStepExecution('failed', now, executionId);
        updateGenerationWorkflowStep(workflowId, execution.step_key, { status: 'failed' });
    });
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
    const workflow = getWorkflowRow(workflowId);
    if (!workflow || workflow.status !== 'active') return null;
    const now = Date.now();
    sql.run`
        INSERT INTO generation_workflow_executions (
            workflow_id, execution_kind, status, recipe, created_at, updated_at
        ) VALUES (${workflowId}, ${kind}, 'queued', ${JSON.stringify(recipe)}, ${now}, ${now})
        ON CONFLICT(workflow_id) DO NOTHING
    `;
    return rowToWorkflowExecution(getWorkflowExecutionRow(workflowId));
}

function getGenerationWorkflowExecution(workflowId, includeRecipe = false) {
    return rowToWorkflowExecution(getWorkflowExecutionRow(workflowId), includeRecipe);
}

function listQueuedGenerationWorkflowExecutions(limit = 20) {
    return sql.all`
        SELECT * FROM generation_workflow_executions
        WHERE execution_kind = 'hypav3-selection' AND status = 'queued'
        ORDER BY created_at ASC LIMIT ${Math.max(1, Math.min(100, Number(limit) || 20))}
    `
        .map(row => rowToWorkflowExecution(row, true));
}

function claimGenerationWorkflowExecution(workflowId) {
    const now = Date.now();
    if (sql.run`
        UPDATE generation_workflow_executions
        SET status = 'running', updated_at = ${now}
        WHERE workflow_id = ${workflowId} AND status = 'queued'
    `.changes !== 1) return null;
    return getGenerationWorkflowExecution(workflowId, true);
}

function finishGenerationWorkflowExecution(workflowId, status, result, error) {
    const now = Date.now();
    return sql.run`
        UPDATE generation_workflow_executions
        SET status = ${status}, result = ${jsonOrNull(result)}, error = ${error || null},
            recipe = '{}', completed_at = ${now}, updated_at = ${now}
        WHERE workflow_id = ${workflowId} AND status IN ('queued', 'running')
    `.changes === 1;
}

function listGenerationWorkflowJobs(workflowId) {
    return sql.all`
        SELECT * FROM generation_jobs WHERE workflow_id = ${workflowId} ORDER BY created_at ASC
    `.map(row => rowToJob(row, false));
}

/** A new user generation supersedes partial output from older terminal work. */
function acknowledgeTerminalGenerationJobsForRoom(characterId, roomId) {
    const now = Date.now();
    return sql.run`
        UPDATE generation_jobs
        SET materialized_at = COALESCE(materialized_at, ${now}), updated_at = ${now}
        WHERE character_id = ${characterId} AND room_id = ${roomId}
          AND job_type = 'model' AND materialized_at IS NULL
          AND workflow_id IN (
              SELECT workflow_id FROM generation_workflows
              WHERE character_id = ${characterId} AND room_id = ${roomId}
                AND status IN ('cancelled', 'failed')
          )
    `.changes;
}

function ensureGenerationStepExecution(input, status) {
    if (!input.workflowId) return undefined;
    const existing = getStepExecutionRow(input.stepExecutionId);
    if (existing) {
        if (
            existing.workflow_id !== input.workflowId
            || existing.step_key !== input.workflowStepKey
        ) {
            const error = new Error('Step execution belongs to a different workflow step');
            error.httpStatus = 409;
            throw error;
        }
        updateStepExecution(status, Date.now(), input.stepExecutionId);
        return rowToStepExecution(getStepExecutionRow(input.stepExecutionId));
    }
    const now = Date.now();
    sql.run`
        INSERT INTO generation_workflow_step_executions (
            execution_id, workflow_id, step_key, attempt, status,
            created_at, updated_at
        )
        SELECT ${input.stepExecutionId}, ${input.workflowId}, ${input.workflowStepKey},
            COALESCE(MAX(attempt), 0) + 1, ${status}, ${now}, ${now}
        FROM generation_workflow_step_executions
        WHERE workflow_id = ${input.workflowId} AND step_key = ${input.workflowStepKey}
    `;
    return rowToStepExecution(getStepExecutionRow(input.stepExecutionId));
}

function linkGenerationJobToWorkflow(input) {
    if (!input.workflowId) return;
    const workflow = getWorkflowRow(input.workflowId);
    const context = workflow?.context ? JSON.parse(workflow.context) : undefined;
    const target = context?.kind === 'llm-request' ? context.target
        : { characterId: workflow?.character_id, roomId: workflow?.room_id };
    if (
        !workflow
        || workflow.status !== 'active'
        || target.characterId !== input.characterId
        || target.roomId !== input.roomId
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
    const row = getJobRow(jobId);
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
        generationInfo: row.generation_info ? JSON.parse(row.generation_info) : undefined,
        promptInfo: row.prompt_info ? JSON.parse(row.prompt_info) : undefined,
        rerollSnapshot: row.reroll_snapshot ? JSON.parse(row.reroll_snapshot) : undefined,
        operationContext: row.operation_context ? JSON.parse(row.operation_context) : undefined,
        workflowId: row.workflow_id || undefined,
        workflowStepKey: row.workflow_step_key || undefined,
        workflowStepExecutionId: row.step_execution_id || undefined,
        adapterKind: row.adapter_kind || undefined,
        responseDecoder: row.response_decoder ? JSON.parse(row.response_decoder) : undefined,
        status: row.status,
        responseStatus: row.response_status,
        responseHeaders: row.response_headers ? JSON.parse(row.response_headers) : {},
        ...(includeRaw
            ? { rawResponse, rawBytes }
            : { rawBytes }),
        projection: row.normalized_projection ? JSON.parse(row.normalized_projection) : undefined,
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


function createSingleGenerationJob(input) {
    return withTransaction(db, () => {
        const workflowId = `request.${input.jobId}`;
        const result = createGenerationWorkflow({
            workflowId, characterId: input.characterId || 'requests', roomId: workflowId,
            context: { schemaVersion: 1, kind: 'llm-request', target: {
                characterId: input.characterId, roomId: input.roomId,
            } },
            plan: [{ key: 'request.llm', kind: 'provider', order: 0,
                recoveryPolicy: 'replay_output', status: 'pending' }],
        });
        if (result.busy) throw new Error('Request workflow already exists');
        return createGenerationJob({ ...input, workflowId,
            workflowStepKey: 'request.llm', stepExecutionId: input.jobId });
    });
}

function createGenerationJob(input) {
    const now = Date.now();
    const activeWorkflow = input.characterId && input.roomId
        ? getActiveWorkflowRow(input.characterId, input.roomId)
        : null;
    if (activeWorkflow && activeWorkflow.workflow_id !== input.workflowId
        && getGenerationWorkflow(input.workflowId, false)?.context?.kind !== 'llm-request') {
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
        withTransaction(db, () => {
            const pendingProviderRound =
                (input.jobType || 'model') === 'model'
                && input.workflowStepKey === 'model.main'
                && input.workflowId
                && input.stepExecutionId
                ? sql.get`
                    SELECT adapter_kind
                    FROM generation_jobs AS jobs
                    WHERE workflow_id = ${input.workflowId}
                      AND workflow_step_key = ${input.workflowStepKey}
                      AND step_execution_id = ${input.stepExecutionId}
                      AND job_type = 'model'
                      AND status = 'generated'
                      AND materialized_at IS NULL
                      AND json_extract(normalized_projection, '$.source') = 'server'
                      AND json_extract(normalized_projection, '$.awaitingProviderResult') = 1
                      AND EXISTS (
                          SELECT 1 FROM generation_workflows AS workflows
                          WHERE workflows.workflow_id = jobs.workflow_id
                            AND workflows.status = 'active'
                            AND json_extract(workflows.context, '$.kind') = 'chat-generation'
                      )
                    ORDER BY rowid DESC
                    LIMIT 1
                `
                : undefined;
            const adapterKind = typeof input.adapterKind === 'string' ? input.adapterKind.slice(0, 64) : null;
            const requestSpec = input.requestSpec
                ? Buffer.from(encodeGenerationRequest(input.requestSpec).buffer)
                : null;
            const normalizedProjection = pendingProviderRound
                ? JSON.stringify({
                    schemaVersion: 1,
                    source: 'server',
                    adapterKind: adapterKind ?? (pendingProviderRound.adapter_kind || 'openai-compatible'),
                    content: '',
                    awaitingProviderResult: true,
                })
                : null;
            sql.run`
                INSERT INTO generation_jobs (
                    job_id, chat_id, job_type, character_id, room_id,
                    generation_info, prompt_info, reroll_snapshot,
                    operation_context, workflow_id, workflow_step_key, step_execution_id,
                    adapter_kind, response_decoder,
                    dispatch_group, dispatch_max_concurrent,
                    request_spec,
                    normalized_projection,
                    status, created_at, updated_at
                ) VALUES (
                    ${input.jobId}, ${input.chatId || null}, ${input.jobType || 'model'},
                    ${input.characterId || null}, ${input.roomId || null},
                    ${jsonOrNull(input.generationInfo)}, ${jsonOrNull(input.promptInfo)}, ${jsonOrNull(input.rerollSnapshot)},
                    ${jsonOrNull(input.operationContext)}, ${input.workflowId || null},
                    ${input.workflowStepKey || null}, ${input.stepExecutionId || null},
                    ${adapterKind}, ${jsonOrNull(input.responseDecoder)},
                    ${input.dispatchGroup || null}, ${input.dispatchMaxConcurrent || null},
                    ${requestSpec},
                    ${normalizedProjection},
                    'queued', ${now}, ${now}
                )
            `;
            linkGenerationJobToWorkflow(input);
            if (input.workflowId && input.workflowStepKey) {
                // Tool loops and application retries can issue more than one
                // provider round for one logical step execution. The aggregate
                // step retains the latest job while the execution keeps the
                // complete one-to-many relationship.
                sql.run`
                    UPDATE generation_jobs
                    SET materialized_at = COALESCE(materialized_at, ${now}), updated_at = ${now}
                    WHERE workflow_id = ${input.workflowId}
                      AND workflow_step_key = ${input.workflowStepKey}
                      AND job_id <> ${input.jobId}
                      AND status NOT IN ('queued', 'generating')
                `;
            }
        });
    } catch (error) {
        generationJournalStore.remove(input.workflowId || null, input.jobId);
        throw error;
    }
    return getGenerationJob(input.jobId);
}

function getGenerationJob(jobId, includeRaw = true) {
    return rowToJob(getJobRow(jobId), includeRaw);
}

function setGenerationJobGenerating(jobId) {
    const now = Date.now();
    sql.run`
        UPDATE generation_jobs
        SET status = 'generating', dispatched_at = COALESCE(dispatched_at, ${now}), updated_at = ${now}
        WHERE job_id = ${jobId} AND status = 'queued'
    `;
    updateGenerationJobWorkflowStep(jobId, 'waiting_job');
}

function listQueuedGenerationDispatches(limit = 500) {
    const normalized = Math.max(1, Math.min(1000, Number(limit) || 500));
    return sql.all`
        SELECT *
        FROM generation_jobs
        WHERE status = 'queued' AND request_spec IS NOT NULL
        ORDER BY created_at ASC
        LIMIT ${normalized}
    `.map(row => ({
        job: rowToJob(row, false),
        dispatchGroup: row.dispatch_group,
        maxConcurrent: Math.max(1, Number(row.dispatch_max_concurrent) || 1),
        requestSpec: decodeGenerationRequest(row.request_spec),
    }));
}

function getGenerationDispatchState(dispatchGroup) {
    const row = sql.get`
        SELECT
            COALESCE(SUM(CASE WHEN status = 'generating' THEN 1 ELSE 0 END), 0) AS active
        FROM generation_jobs
        WHERE dispatch_group = ${dispatchGroup}
    `;
    return { active: row.active };
}

function claimQueuedGenerationDispatch(jobId) {
    const row = getJobRow(jobId);
    if (!row?.request_spec || row.status !== 'queued') return undefined;
    const requestSpec = decodeGenerationRequest(row.request_spec);
    const now = Date.now();
    const result = sql.run`
        UPDATE generation_jobs
        SET status = 'generating', request_spec = NULL,
            dispatched_at = ${now}, updated_at = ${now}
        WHERE job_id = ${jobId} AND status = 'queued' AND request_spec IS NOT NULL
    `;
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
    sql.run`
        UPDATE generation_jobs
        SET response_status = ${status}, response_headers = ${JSON.stringify(headers || {})}, updated_at = ${Date.now()}
        WHERE job_id = ${jobId}
    `;
}

function finishGenerationJob(jobId, status, finishReason, error = null, rawBytes) {
    const now = Date.now();
    const job = getJobRow(jobId);
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
        if (job) setRawBytes(journalBytes, jobId);
        return false;
    }
    sql.run`
        UPDATE generation_jobs
        SET status = ${status}, finish_reason = ${finishReason || null}, error = ${error || null},
            raw_bytes = ${journalBytes}, request_spec = NULL, completed_at = ${now}, updated_at = ${now}
        WHERE job_id = ${jobId}
    `;
    updateGenerationJobWorkflowStep(
        jobId,
        status === 'generated' ? 'output_ready' : 'failed',
    );
    if (job?.workflow_id && getGenerationWorkflow(job.workflow_id, false)?.context?.kind === 'llm-request') {
        updateGenerationWorkflowStep(job.workflow_id, 'request.llm', {
            status: status === 'generated' ? 'completed' : 'failed',
        });
        finishGenerationWorkflow(job.workflow_id,
            status === 'generated' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed');
    }
    if (job?.job_type === 'model' && job.workflow_id && status !== 'generated') {
        updateGenerationWorkflowStep(job.workflow_id, 'model.main', {
            status: 'failed',
            metadata: {
                schemaVersion: 1,
                error: String(error || finishReason || `Model generation ended as ${status}`),
            },
        });
        // A provider job is one round within the logical model step. The
        // client may retry a pre-response failure by attaching another job to
        // the same step execution, so only an explicit cancellation is
        // terminal here. Exhausted retries and partial-stream failures are
        // finalized by the client workflow boundary.
        if (status === 'cancelled') {
            cancelGenerationWorkflow(job.workflow_id, 'cancelled');
        }
    }
    return true;
}

function readGenerationJobRaw(jobId) {
    const job = getJobRow(jobId);
    return generationJournalStore.readAll(job?.workflow_id, jobId);
}

function readGenerationJobEvents(jobId) {
    const job = getJobRow(jobId);
    return generationJournalStore.readAll(job?.workflow_id, jobId, 'events');
}

/** Stores the decoded events rebuilt from a job's raw journal. */
function replaceGenerationJobEvents(jobId, events) {
    const job = getJobRow(jobId);
    if (!job) return false;
    generationJournalStore.replace(job.workflow_id, jobId, 'events', events);
    return true;
}

function setGenerationJobProjection(jobId, projection) {
    const now = Date.now();
    const json = JSON.stringify(projection);
    const result = sql.run`
        UPDATE generation_jobs
        SET normalized_projection = ${json}, projection_error = NULL,
            projected_at = ${now}, updated_at = ${now}
        WHERE job_id = ${jobId}
          AND json_extract(${json}, '$.source') = 'server'
          AND COALESCE(json_extract(normalized_projection, '$.source'), '') <> 'provider'
    `;
    return result.changes === 1;
}

function setGenerationJobProviderResult(jobId, projection) {
    const now = Date.now();
    const json = JSON.stringify(projection);
    const result = sql.run`
        UPDATE generation_jobs
        SET normalized_projection = ${json}, projection_error = NULL,
            projected_at = ${now}, updated_at = ${now}
        WHERE job_id = ${jobId}
          AND json_extract(normalized_projection, '$.source') = 'server'
          AND json_extract(normalized_projection, '$.awaitingProviderResult') = 1
          AND json_extract(${json}, '$.source') = 'provider'
          AND status = 'generated'
          AND materialized_at IS NULL
          AND COALESCE(json_extract(${json}, '$.awaitingProviderResult'), 0) <> 1
    `;
    return result.changes === 1;
}

function setGenerationJobProjectionError(jobId, error) {
    const result = sql.run`
        UPDATE generation_jobs
        SET projection_error = ${String(error ?? '')}, updated_at = ${Date.now()}
        WHERE job_id = ${jobId}
    `;
    return result.changes === 1;
}

function updateGenerationJobMetadata(jobId, generationInfo, promptInfo) {
    const result = sql.run`
        UPDATE generation_jobs
        SET generation_info = ${jsonOrNull(generationInfo)}, prompt_info = ${jsonOrNull(promptInfo)},
            updated_at = ${Date.now()}
        WHERE job_id = ${jobId}
    `;
    return result.changes === 1;
}

function listRecoverableGenerationJobs(limit = 50) {
    const normalized = Math.max(1, Math.min(200, Number(limit) || 50));
    return sql.all`
        SELECT * FROM recoverable_main_jobs
        ORDER BY updated_at DESC
        LIMIT ${normalized}
    `.map(row => rowToJob(row, false));
}

function getEarlierRecoverableGenerationWorkflowJob(characterId, roomId, createdAt) {
    return rowToJob(
        sql.get`
            SELECT * FROM recoverable_main_jobs
            WHERE workflow_id IS NOT NULL
              AND character_id = ${characterId}
              AND room_id = ${roomId}
              AND created_at < ${createdAt}
            ORDER BY created_at ASC
            LIMIT 1
        `,
        false,
    );
}

function listRecoverableAuxiliaryJobs(limit = 200) {
    const normalized = Math.max(1, Math.min(500, Number(limit) || 200));
    return sql.all`
        SELECT *
        FROM generation_jobs
        WHERE job_type <> 'model'
          AND operation_context IS NOT NULL
          AND status IN ('queued', 'generating', 'generated', 'cancelled', 'interrupted', 'failed_partial', 'failed')
          AND materialized_at IS NULL
        ORDER BY created_at ASC
        LIMIT ${normalized}
    `.map(row => rowToJob(row, false));
}

function listGenerationJobsNeedingProjection(limit = 200, schemaVersion = 1) {
    const normalized = Math.max(1, Math.min(500, Number(limit) || 200));
    return sql.all`
        SELECT *
        FROM generation_jobs
        WHERE raw_bytes > 0
          AND response_decoder IS NOT NULL
          AND response_status >= 200
          AND response_status < 300
          AND (
            normalized_projection IS NULL
            OR COALESCE(json_extract(normalized_projection, '$.schemaVersion'), 0) <> ${Number(schemaVersion) || 1}
            OR COALESCE(json_extract(normalized_projection, '$.source'), '') <> 'server'
          )
          AND COALESCE(json_extract(normalized_projection, '$.source'), '') <> 'provider'
          AND status IN ('generated', 'interrupted', 'cancelled', 'failed_partial', 'failed')
        ORDER BY updated_at ASC
        LIMIT ${normalized}
    `
        .map(row => rowToJob(row, false));
}

function markGenerationMaterialized(jobId) {
    const job = getJobRow(jobId);
    const result = sql.run`
        UPDATE generation_jobs
        SET materialized_at = ${Date.now()}, updated_at = ${Date.now()}
        WHERE job_id = ${jobId}
    `;
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
    withTransaction(db, () => {
        // Recoverable output is retained for one day even when a client never
        // returns to materialize/consume it. After that deadline, terminal jobs
        // and their journals are no longer useful and must not accumulate.
        for (const row of sql.all`
            SELECT job_id, workflow_id
            FROM generation_jobs
            WHERE status NOT IN ('queued', 'generating')
              AND completed_at IS NOT NULL
              AND completed_at < ${cutoff}
            ORDER BY completed_at ASC, created_at ASC
        `) {
            sql.run`DELETE FROM generation_jobs WHERE job_id = ${row.job_id}`;
            deletedJobs.push({ jobId: row.job_id, workflowId: row.workflow_id });
        }
    });
    for (const job of deletedJobs) {
        generationJournalStore.remove(job.workflowId, job.jobId);
    }
    const validJournals = new Set(allJobIds().map(row =>
        generationJournalStore.journalKey(row.workflow_id, row.job_id)));
    const orphaned = generationJournalStore.removeOrphans(validJournals, cutoff);
    let workflowsDeleted = 0;
    withTransaction(db, () => {
        sql.run`
            DELETE FROM generation_workflow_executions
            WHERE status IN ('completed', 'failed') AND completed_at < ${cutoff}
        `;
        sql.run`
            DELETE FROM generation_workflow_step_executions
            WHERE workflow_id IN (
                SELECT workflow_id FROM generation_workflows
                WHERE status <> 'active' AND completed_at < ${cutoff}
            )
        `;
        sql.run`
            DELETE FROM generation_workflow_steps
            WHERE workflow_id IN (
                SELECT workflow_id FROM generation_workflows
                WHERE status <> 'active' AND completed_at < ${cutoff}
            )
        `;
        sql.run`
            DELETE FROM workflowChatSnapshots
            WHERE workflow_id IN (
                SELECT workflow_id FROM generation_workflows
                WHERE status <> 'active' AND completed_at < ${cutoff}
            )
        `;
        workflowsDeleted = sql.run`
            DELETE FROM generation_workflows
            WHERE status <> 'active' AND completed_at < ${cutoff}
        `.changes;
    });
    if (deletedJobs.length > 0) checkpointGenerationDb();
    return {
        deleted: deletedJobs.length,
        orphaned,
        workflowsDeleted,
        bytes: Number(sql.get`
            SELECT COALESCE(SUM(
                raw_bytes + length(CAST(COALESCE(normalized_projection, '') AS BLOB))
                + length(CAST(COALESCE(projection_error, '') AS BLOB))
                + length(CAST(COALESCE(generation_info, '') AS BLOB))
                + length(CAST(COALESCE(prompt_info, '') AS BLOB))
                + length(CAST(COALESCE(reroll_snapshot, '') AS BLOB))
                + length(CAST(COALESCE(operation_context, '') AS BLOB))
                + length(CAST(COALESCE(response_headers, '') AS BLOB))
                + length(CAST(COALESCE(error, '') AS BLOB))
            ), 0) AS total
            FROM generation_jobs
            WHERE materialized_at IS NOT NULL
        `?.total) || 0,
    };
}

function checkpointGenerationDb(mode = 'PASSIVE') {
    db.exec(`PRAGMA wal_checkpoint(${mode})`);
}

module.exports = {
    createSingleGenerationJob,
    createGenerationWorkflow,
    getGenerationWorkflow,
    getGenerationWorkflowInputChat,
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
    acknowledgeTerminalGenerationJobsForRoom,
    createGenerationJob,
    getGenerationJob,
    setGenerationJobGenerating,
    listQueuedGenerationDispatches,
    getGenerationDispatchState,
    claimQueuedGenerationDispatch,
    setGenerationJobHeaders,
    readGenerationJobRaw,
    readGenerationJobEvents,
    replaceGenerationJobEvents,
    setGenerationJobProjection,
    setGenerationJobProviderResult,
    setGenerationJobProjectionError,
    updateGenerationJobMetadata,
    finishGenerationJob,
    listRecoverableGenerationJobs,
    getEarlierRecoverableGenerationWorkflowJob,
    listRecoverableAuxiliaryJobs,
    listGenerationJobsNeedingProjection,
    markGenerationMaterialized,
    pruneRetainedGenerationJobs,
    checkpointGenerationDb,
};

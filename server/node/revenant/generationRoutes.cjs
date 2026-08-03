'use strict';

const {
    createGenerationWorkflow,
    getGenerationWorkflow,
    getActiveGenerationWorkflow,
    claimGenerationWorkflowClientAction,
    hasGenerationWorkflowClientActionClaim,
    resolveGenerationWorkflowClientAction,
    consumeGenerationWorkflowClientActionJobs,
    updateGenerationWorkflowStep,
    putGenerationWorkflowExecution,
    getGenerationWorkflowExecution,
    createGenerationJob,
    getGenerationJob,
    setGenerationJobClientProjection,
    updateGenerationJobMetadata,
    finishGenerationJob,
    listRecoverableGenerationJobs,
    listRecoverableAuxiliaryJobs,
    markGenerationMaterialized,
    pruneRetainedGenerationJobs,
} = require('./generationDb.cjs');
const {
    isRevenantJobActive,
    isValidRevenantWorkflowKey,
    isRevenantWorkflowClientActionJobAllowed,
    normalizeRevenantJobType,
    normalizeRevenantDispatchPolicy,
    normalizeRevenantWorkflowDependency,
    normalizeRevenantHypaExecutionRecipe,
    normalizeRevenantOperationContext,
    normalizeRevenantWorkflowContext,
    normalizeRevenantWorkflowPlan,
    normalizeRevenantWorkflowStepUpdate,
    normalizeRevenantWorkflowTerminalStatus,
} = require('./generation.cjs');
const { createClientGenerationProjection } = require('./generationProjection.cjs');

function installRevenantGenerationRoutes(app, deps) {
    const {
        checkProxyAuth,
        requireSyncClientId,
        sanitizeGenerationTargetUrl,
        normalizeForwardHeaders,
        createGenerationRuntimeJob,
        runGenerationProviderJob,
        scheduleGenerationDispatch,
        scheduleHypaWorkflowExecution,
        scheduleRevenantPostprocess = () => {},
        notifyRevenantWorkflowUpdated = () => {},
        terminateGenerationWorkflow,
        cancelGenerationStepExecution,
        generationRuntimeJobs,
        countActiveGenerationJobs,
        maxActiveJobs,
        maxBodyBase64Bytes,
        randomUUID,
    } = deps;

    app.post('/api/generation/workflows', async (req, res, next) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const characterId = typeof req.body?.characterId === 'string' ? req.body.characterId : '';
        const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : '';
        const plan = normalizeRevenantWorkflowPlan(req.body?.plan);
        const context = normalizeRevenantWorkflowContext(req.body?.context, characterId, roomId);
        if (!characterId || !roomId || !plan || !context) {
            res.status(400).send({ error: 'characterId, roomId, plan, and workflow context are required' });
            return;
        }
        try {
            const result = createGenerationWorkflow({
                workflowId: randomUUID(),
                characterId,
                roomId,
                plan,
                context,
            });
            if (result.busy) {
                res.status(409).send({
                    error: 'A generation workflow is already active for this room',
                    workflow: result.workflow,
                });
                return;
            }
            res.send({ workflow: result.workflow });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/generation/workflows/active', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        const characterId = typeof req.query?.characterId === 'string' ? req.query.characterId : '';
        const roomId = typeof req.query?.roomId === 'string' ? req.query.roomId : '';
        if (!characterId || !roomId) {
            res.status(400).send({ error: 'characterId and roomId are required' });
            return;
        }
        res.send({ workflow: getActiveGenerationWorkflow(characterId, roomId) });
    });

    app.get('/api/generation/workflows/:workflowId', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        const workflow = getGenerationWorkflow(req.params.workflowId);
        if (!workflow) {
            res.status(404).send({ error: 'Generation workflow not found' });
            return;
        }
        res.send({ workflow });
    });

    // Cancellation is an authenticated terminal control command. Workflow
    // execution is server-owned, so any reconnected browser may stop it.
    app.post('/api/generation/workflows/:workflowId/cancel', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const workflow = getGenerationWorkflow(req.params.workflowId, false);
        if (!workflow) {
            res.status(404).send({ error: 'Generation workflow not found' });
            return;
        }
        const result = await terminateGenerationWorkflow(req.params.workflowId, 'cancelled');
        notifyRevenantWorkflowUpdated(getGenerationWorkflow(req.params.workflowId));
        res.send({
            success: true,
            ...(result.changed ? {} : { alreadyFinished: true }),
        });
    });

    app.put('/api/generation/workflows/:workflowId/steps/:stepKey', async (req, res, next) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const stepKey = req.params.stepKey;
        const update = normalizeRevenantWorkflowStepUpdate(req.body);
        if (!isValidRevenantWorkflowKey(stepKey) || !update) {
            res.status(400).send({ error: 'Invalid generation workflow step update' });
            return;
        }
        try {
            if (!updateGenerationWorkflowStep(req.params.workflowId, stepKey, update)) {
                res.status(404).send({ error: 'Active generation workflow not found' });
                return;
            }
            res.send({ success: true });
        } catch (error) {
            if (String(error?.message || '').startsWith('Unknown generation workflow step:')) {
                res.status(404).send({ error: error.message });
                return;
            }
            next(error);
        }
    });

    app.post('/api/generation/workflows/:workflowId/steps/:stepKey/client-action/claim', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const stepKey = req.params.stepKey;
        const actionId = typeof req.body?.actionId === 'string' ? req.body.actionId : '';
        if (!isValidRevenantWorkflowKey(stepKey) || !isValidRevenantWorkflowKey(actionId)) {
            res.status(400).send({ error: 'Invalid workflow client action' });
            return;
        }
        const result = claimGenerationWorkflowClientAction(
            req.params.workflowId,
            stepKey,
            actionId,
            String(req.headers['x-sync-client-id'] || ''),
        );
        if (!result) {
            res.status(404).send({ error: 'Pending workflow client action not found' });
            return;
        }
        if (result.busy) {
            res.status(409).send({ error: 'Workflow client action is already claimed', ...result });
            return;
        }
        res.send(result);
    });

    app.post('/api/generation/workflows/:workflowId/steps/:stepKey/client-action/resolve', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const stepKey = req.params.stepKey;
        const actionId = typeof req.body?.actionId === 'string' ? req.body.actionId : '';
        if (
            !isValidRevenantWorkflowKey(stepKey)
            || !isValidRevenantWorkflowKey(actionId)
            || !Object.prototype.hasOwnProperty.call(req.body || {}, 'response')
        ) {
            res.status(400).send({ error: 'Invalid workflow client action response' });
            return;
        }
        let serialized;
        try { serialized = JSON.stringify(req.body.response); }
        catch {
            res.status(400).send({ error: 'Workflow client action response must be JSON serializable' });
            return;
        }
        if (serialized === undefined || Buffer.byteLength(serialized) > 8 * 1024 * 1024) {
            res.status(413).send({ error: 'Workflow client action response is too large' });
            return;
        }
        const delegatedAction = getGenerationWorkflow(req.params.workflowId)
            ?.steps?.find(step => step.key === stepKey)
            ?.metadata?.action;
        const result = resolveGenerationWorkflowClientAction(
            req.params.workflowId,
            stepKey,
            actionId,
            String(req.headers['x-sync-client-id'] || ''),
            req.body.response,
        );
        if (!result) {
            res.status(404).send({ error: 'Pending workflow client action not found' });
            return;
        }
        if (result.staleClaim) {
            res.status(409).send({ error: 'Workflow client action claim is stale', ...result });
            return;
        }
        if (
            delegatedAction?.kind === 'provider.main'
            && req.body.response?.success !== true
        ) {
            const error = String(
                req.body.response?.result
                || 'Plugin provider did not dispatch a durable model request',
            );
            updateGenerationWorkflowStep(req.params.workflowId, stepKey, {
                status: 'failed',
                metadata: { schemaVersion: 1, error },
            });
            await terminateGenerationWorkflow(req.params.workflowId, 'failed');
            notifyRevenantWorkflowUpdated(getGenerationWorkflow(req.params.workflowId));
            res.send({ success: true, ...result });
            return;
        }
        consumeGenerationWorkflowClientActionJobs(req.params.workflowId, actionId);
        scheduleRevenantPostprocess();
        res.send({ success: true, ...result });
    });

    app.post('/api/generation/workflows/:workflowId/step-executions/:executionId/cancel', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        if (!isValidRevenantWorkflowKey(req.params.executionId)) {
            res.status(400).send({ error: 'Invalid workflow step execution id' });
            return;
        }
        const result = await cancelGenerationStepExecution(
            req.params.workflowId,
            req.params.executionId,
        );
        if (!result.changed) {
            res.status(404).send({ error: 'Active workflow step execution not found' });
            return;
        }
        res.send({ success: true, cancelledJobs: result.jobs.length });
    });

    app.post('/api/generation/workflows/:workflowId/finish', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const status = normalizeRevenantWorkflowTerminalStatus(req.body?.status);
        if (!status) {
            res.status(400).send({ error: 'Invalid terminal workflow status' });
            return;
        }
        const result = await terminateGenerationWorkflow(req.params.workflowId, status);
        notifyRevenantWorkflowUpdated(getGenerationWorkflow(req.params.workflowId));
        if (!result.changed) {
            const existing = getGenerationWorkflow(req.params.workflowId, false);
            if (!existing) {
                res.status(404).send({ error: 'Generation workflow not found' });
                return;
            }
            res.send({ success: true, alreadyFinished: true });
            return;
        }
        res.send({ success: true });
    });

    app.put('/api/generation/workflows/:workflowId/hypav3-execution', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const recipe = normalizeRevenantHypaExecutionRecipe(req.body);
        if (!recipe) {
            res.status(400).send({ error: 'Invalid HypaV3 execution recipe' });
            return;
        }
        const execution = putGenerationWorkflowExecution(
            req.params.workflowId,
            'hypav3-selection',
            recipe,
        );
        if (!execution) {
            res.status(404).send({ error: 'Active generation workflow not found' });
            return;
        }
        scheduleHypaWorkflowExecution();
        res.send({ execution });
    });

    app.get('/api/generation/workflows/:workflowId/hypav3-execution', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        const execution = getGenerationWorkflowExecution(req.params.workflowId);
        if (!execution) {
            res.status(404).send({ error: 'HypaV3 workflow execution not found' });
            return;
        }
        res.send({ execution });
    });

    // Unlike the legacy local-network proxy jobs, revenant jobs may target an
    // external provider. Metadata lives in save/revenant/revenant.db while exact
    // provider bytes are appended to save/revenant/<workflowId>/<jobId>.journal.
    // Standalone auxiliary jobs use save/revenant/<jobId>.journal. Provider wire
    // parsing is shared by the server projection worker and browser replay.
    app.post('/api/generation/jobs', async (req, res, next) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;

        const url = sanitizeGenerationTargetUrl(req.body?.url);
        if (!url) {
            res.status(400).send({ error: 'Invalid target URL' });
            return;
        }
        const method = typeof req.body?.method === 'string' ? req.body.method.toUpperCase() : 'POST';
        if (!['POST', 'GET', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
            res.status(400).send({ error: 'Invalid method' });
            return;
        }
        const bodyBase64 = typeof req.body?.bodyBase64 === 'string' ? req.body.bodyBase64 : '';
        if (bodyBase64.length > maxBodyBase64Bytes) {
            res.status(413).send({ error: 'Request body too large' });
            return;
        }
        const jobId = randomUUID();
        const jobType = normalizeRevenantJobType(req.body?.jobType);
        const operationContext = normalizeRevenantOperationContext(
            jobType,
            req.body?.operationContext,
        );
        if (req.body?.operationContext != null && operationContext === undefined) {
            res.status(400).send({ error: 'Invalid revenant operation context' });
            return;
        }
        const workflowId = typeof req.body?.workflowId === 'string' ? req.body.workflowId : undefined;
        const workflowStepKey = typeof req.body?.workflowStepKey === 'string'
            ? req.body.workflowStepKey
            : undefined;
        const requestedStepExecutionId = typeof req.body?.workflowStepExecutionId === 'string'
            ? req.body.workflowStepExecutionId
            : undefined;
        const stepExecutionId = workflowId ? requestedStepExecutionId : undefined;
        if (
            (workflowId && (
                !isValidRevenantWorkflowKey(workflowId)
                || !isValidRevenantWorkflowKey(workflowStepKey)
                || !isValidRevenantWorkflowKey(stepExecutionId)
            ))
            || (!workflowId && (workflowStepKey || requestedStepExecutionId))
        ) {
            res.status(400).send({ error: 'Invalid generation workflow job link' });
            return;
        }
        const dispatchPolicy = normalizeRevenantDispatchPolicy(
            req.body?.dispatchPolicy,
            operationContext,
            workflowId,
        );
        if (req.body?.dispatchPolicy != null && dispatchPolicy === undefined) {
            res.status(400).send({ error: 'Invalid generation dispatch policy' });
            return;
        }
        const workflowDependency = normalizeRevenantWorkflowDependency(
            req.body?.workflowDependency,
            jobType,
            workflowId,
        );
        if (req.body?.workflowDependency != null && workflowDependency === undefined) {
            res.status(400).send({ error: 'Invalid generation workflow dependency' });
            return;
        }
        if (workflowDependency && workflowStepKey !== 'model.main') {
            res.status(400).send({ error: 'Workflow dependencies are only valid for model.main' });
            return;
        }
        const workflowClientAction = req.body?.workflowClientAction;
        let delegatedMainDispatch = false;
        let delegatedParentStepKey;
        let workflow;
        if (workflowId) {
            workflow = getGenerationWorkflow(workflowId);
            if (!workflow || workflow.status !== 'active') {
                res.status(404).send({ error: 'Active generation workflow not found' });
                return;
            }
            if (
                req.body?.characterId !== workflow.characterId
                || req.body?.roomId !== workflow.roomId
            ) {
                res.status(409).send({ error: 'Generation job target does not match its workflow' });
                return;
            }
        }
        if (workflowId && workflowClientAction) {
            delegatedParentStepKey = workflowClientAction.parentStepKey;
            const delegatedAction = workflow.steps
                .find(step => step.key === delegatedParentStepKey)
                ?.metadata?.action;
            delegatedMainDispatch = delegatedAction?.kind === 'provider.main';
            if (
                typeof workflowClientAction.parentStepKey !== 'string'
                || typeof workflowClientAction.actionId !== 'string'
                || !isValidRevenantWorkflowKey(workflowClientAction.parentStepKey)
                || !isValidRevenantWorkflowKey(workflowClientAction.actionId)
                || !isRevenantWorkflowClientActionJobAllowed({
                    parentStepKey: workflowClientAction.parentStepKey,
                    actionId: workflowClientAction.actionId,
                    jobType,
                    workflowStepKey,
                    action: delegatedAction,
                })
                || (workflowDependency && !delegatedMainDispatch)
                || !hasGenerationWorkflowClientActionClaim(
                    workflowId,
                    workflowClientAction.parentStepKey,
                    workflowClientAction.actionId,
                    String(req.headers['x-sync-client-id'] || ''),
                )
            ) {
                res.status(409).send({ error: 'Workflow client action claim is not active' });
                return;
            }
        }
        if (!dispatchPolicy && !workflowDependency && countActiveGenerationJobs() >= maxActiveJobs) {
            res.status(429).send({ error: 'Too many active generation jobs. Retry shortly.' });
            return;
        }
        const forwardHeaders = normalizeForwardHeaders(req.body?.headers);
        const usageProviderId = typeof req.body?.usageProviderId === 'string'
            ? req.body.usageProviderId.slice(0, 128)
            : undefined;
        const usageModelId = typeof req.body?.usageModelId === 'string'
            ? req.body.usageModelId.slice(0, 256)
            : undefined;
        const usageServiceTier = req.body?.usageServiceTier === 'batch'
            ? 'batch'
            : undefined;
        const requestLog = {
            chatId: req.body?.chatId,
            clientId: String(req.headers['x-sync-client-id'] || '').slice(0, 6),
            platform: /Android|iPhone|iPad|iPod|Mobile/i.test(req.headers['user-agent'] || '')
                ? 'Mobile'
                : 'Desktop',
        };
        const requestSpec = dispatchPolicy || workflowDependency ? {
            targetUrl: url,
            headers: forwardHeaders,
            method,
            bodyBase64,
            timeoutMs: req.body?.timeoutMs,
            heartbeatSec: req.body?.heartbeatSec,
            usageProviderId,
            usageModelId,
            usageServiceTier,
            requestLog,
            ...(workflowDependency ? { workflowDependency } : {}),
        } : undefined;
        try {
            createGenerationJob({
                jobId,
                chatId: req.body?.chatId,
                jobType,
                characterId: req.body?.characterId,
                roomId: req.body?.roomId,
                isContinuation: req.body?.isContinuation === true,
                continuationPrefix: req.body?.continuationPrefix,
                generationInfo: req.body?.generationInfo,
                promptInfo: req.body?.promptInfo,
                rerollSnapshot: req.body?.rerollSnapshot,
                operationContext,
                workflowId,
                workflowStepKey,
                stepExecutionId,
                adapterKind: req.body?.adapterKind,
                streaming: req.body?.streaming === true,
                dispatchGroup: dispatchPolicy?.dispatchGroup
                    || (workflowDependency ? `${workflowId}:main` : undefined),
                dispatchMaxConcurrent: dispatchPolicy?.maxConcurrent
                    || (workflowDependency ? 1 : undefined),
                dispatchRequestsPerMinute: dispatchPolicy?.requestsPerMinute
                    || (workflowDependency ? 1000 : undefined),
                requestSpec,
            });
            if (delegatedMainDispatch && !updateGenerationWorkflowStep(
                workflowId,
                delegatedParentStepKey,
                {
                    status: 'completed',
                    metadata: { schemaVersion: 1, jobId },
                },
            )) {
                finishGenerationJob(jobId, 'cancelled', 'workflow_failed');
                throw new Error('Failed to complete delegated main provider dispatch');
            }
            if (workflowId) scheduleHypaWorkflowExecution();
        } catch (error) {
            if (error?.httpStatus) {
                res.status(error.httpStatus).send({
                    error: error.message,
                    workflowId: error.workflowId,
                });
                return;
            }
            if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                res.status(409).send({ error: 'A main generation job is already active for this room' });
                return;
            }
            next(error);
            return;
        }
        const job = createGenerationRuntimeJob({
            jobId,
            workflowId,
            heartbeatSec: req.body?.heartbeatSec,
            timeoutMs: req.body?.timeoutMs,
        });
        if (dispatchPolicy || workflowDependency) {
            job.waitingDispatch = true;
            scheduleGenerationDispatch();
        } else {
            job.runPromise = runGenerationProviderJob(job, {
                targetUrl: url,
                headers: forwardHeaders,
                method,
                bodyBase64,
                usageProviderId,
                usageModelId,
                usageServiceTier,
                requestLog,
            });
            void job.runPromise;
        }

        res.send({ jobId, heartbeatSec: job.heartbeatSec });
    });

    app.get('/api/generation/jobs/recoverable', async (req, res, next) => {
        if (!await checkProxyAuth(req, res)) return;
        try {
            res.send({ jobs: listRecoverableGenerationJobs(req.query?.limit) });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/generation/jobs/auxiliary-recoverable', async (req, res, next) => {
        if (!await checkProxyAuth(req, res)) return;
        try {
            res.send({ jobs: listRecoverableAuxiliaryJobs(req.query?.limit) });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/generation/jobs/prune-retained', async (req, res, next) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            res.send(pruneRetainedGenerationJobs());
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/generation/jobs/:jobId', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        const job = getGenerationJob(req.params.jobId, false);
        if (!job) {
            res.status(404).send({ error: 'Generation job not found' });
            return;
        }
        res.send(job);
    });

    app.delete('/api/generation/jobs/:jobId', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const persisted = getGenerationJob(req.params.jobId, false);
        const job = generationRuntimeJobs.get(req.params.jobId);
        if (job && !job.done) {
            job.abortController.abort();
            finishGenerationJob(req.params.jobId, 'cancelled', 'user_cancelled');
        } else {
            if (persisted && isRevenantJobActive(persisted.status)) {
                finishGenerationJob(req.params.jobId, 'cancelled', 'user_cancelled');
            }
        }
        // DELETE is an explicit user cancellation. The client keeps any partial
        // text it has already displayed, so do not let revenant recovery replay
        // this job later and overwrite subsequent user edits.
        markGenerationMaterialized(req.params.jobId);
        res.send({ success: true });
    });

    app.post('/api/generation/jobs/:jobId/consume', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const job = getGenerationJob(req.params.jobId, false);
        if (!job) {
            res.status(404).send({ error: 'Generation job not found' });
            return;
        }
        if (job.jobType === 'model') {
            res.status(400).send({ error: 'Main generation jobs must be materialized' });
            return;
        }
        if (isRevenantJobActive(job.status)) {
            res.status(409).send({ error: 'Auxiliary generation job is not complete' });
            return;
        }
        if (!markGenerationMaterialized(req.params.jobId)) {
            res.status(404).send({ error: 'Generation job not found' });
            return;
        }
        res.send({ success: true });
    });

    app.put('/api/generation/jobs/:jobId/projection', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const content = typeof req.body?.content === 'string' ? req.body.content : null;
        if (content === null) {
            res.status(400).send({ error: 'content is required' });
            return;
        }
        const job = getGenerationJob(req.params.jobId, false);
        if (!job) {
            res.status(404).send({ error: 'Generation job not found' });
            return;
        }
        setGenerationJobClientProjection(
            req.params.jobId,
            createClientGenerationProjection(job, content),
        );
        res.send({ success: true });
    });

    app.put('/api/generation/jobs/:jobId/metadata', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const job = getGenerationJob(req.params.jobId, false);
        if (!job) {
            res.status(404).send({ error: 'Generation job not found' });
            return;
        }
        if (!updateGenerationJobMetadata(
            req.params.jobId,
            req.body?.generationInfo,
            req.body?.promptInfo,
        )) {
            res.status(404).send({ error: 'Generation job not found' });
            return;
        }
        res.send({ success: true });
    });

}

module.exports = {
    installRevenantGenerationRoutes,
};

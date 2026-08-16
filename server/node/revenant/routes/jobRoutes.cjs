'use strict';

const {
    getGenerationWorkflow,
    hasGenerationWorkflowClientActionClaim,
    updateGenerationWorkflowStep,
    createGenerationJob,
    getGenerationJob,
    listGenerationWorkflowJobs,
    setGenerationJobClientProjection,
    updateGenerationJobMetadata,
    finishGenerationJob,
    listRecoverableGenerationJobs,
    listRecoverableAuxiliaryJobs,
    markGenerationMaterialized,
    pruneRetainedGenerationJobs,
} = require('../generationDb.cjs');
const {
    isRevenantJobActive,
    isValidRevenantWorkflowKey,
    isRevenantWorkflowClientActionJobAllowed,
    normalizeRevenantJobType,
    normalizeRevenantDispatchPolicy,
    normalizeRevenantWorkflowDependency,
    normalizeRevenantOperationContext,
} = require('../generation.cjs');
const { createClientGenerationProjection } = require('../generationProjection.cjs');
const { findReusableActiveMainJob } = require('./policy.cjs');
const {
    createGenerationJobCancellationService,
} = require('../generationWorkflowService.cjs');

function installRevenantJobRoutes(app, deps) {
    const {
        checkProxyAuth,
        requireSyncClientId,
        sanitizeGenerationTargetUrl,
        normalizeForwardHeaders,
        createGenerationRuntimeJob,
        runGenerationProviderJob,
        scheduleGenerationDispatch,
        scheduleHypaWorkflowExecution,
        generationRuntimeJobs,
        countActiveGenerationJobs,
        maxActiveJobs,
        maxBodyBase64Bytes,
        randomUUID,
        terminateGenerationWorkflow,
        notifyRevenantWorkflowUpdated = () => {},
    } = deps;
    const cancellationRepository = {
        getGenerationJob: deps.getGenerationJob ?? getGenerationJob,
        getGenerationWorkflow: deps.getGenerationWorkflow ?? getGenerationWorkflow,
        finishGenerationJob: deps.finishGenerationJob ?? finishGenerationJob,
        markGenerationMaterialized: deps.markGenerationMaterialized ?? markGenerationMaterialized,
    };
    const cancellationService = createGenerationJobCancellationService({
        repository: cancellationRepository,
        generationRuntimeJobs,
        terminateGenerationWorkflow,
        notifyRevenantWorkflowUpdated,
        isJobActive: isRevenantJobActive,
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
                // Another browser can enter pre-model recovery in the small
                // window between workflow creation and observing the first
                // durable main job. Both requests represent the same logical
                // workflow step, so attach the later observer to the existing
                // job instead of making it fail the whole workflow (which
                // would abort the provider request that won this race).
                const reusableJob = workflowId
                    ? findReusableActiveMainJob(
                        listGenerationWorkflowJobs(workflowId),
                        {
                            jobType,
                            workflowId,
                            workflowStepKey,
                            characterId: req.body?.characterId,
                            roomId: req.body?.roomId,
                        },
                    )
                    : undefined;
                if (reusableJob) {
                    const runtimeJob = generationRuntimeJobs.get(reusableJob.jobId);
                    res.send({
                        jobId: reusableJob.jobId,
                        heartbeatSec: runtimeJob?.heartbeatSec,
                        reused: true,
                    });
                    return;
                }
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
                adapterKind: req.body?.adapterKind,
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

    app.delete('/api/generation/jobs/:jobId', async (req, res, next) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            res.send(await cancellationService.cancel(req.params.jobId));
        } catch (error) {
            next(error);
        }
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

module.exports = { installRevenantJobRoutes };

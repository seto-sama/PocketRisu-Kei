'use strict';

const {
    createGenerationWorkflow,
    getGenerationWorkflow,
    getActiveGenerationWorkflow,
    claimGenerationWorkflowClientAction,
    resolveGenerationWorkflowClientAction,
    consumeGenerationWorkflowClientActionJobs,
    updateGenerationWorkflowStep,
    putGenerationWorkflowExecution,
    getGenerationWorkflowExecution,
    listGenerationWorkflowJobs,
} = require('../generationDb.cjs');
const {
    isValidRevenantWorkflowKey,
    normalizeRevenantHypaExecutionRecipe,
    normalizeRevenantWorkflowContext,
    normalizeRevenantWorkflowPlan,
    normalizeRevenantWorkflowStepUpdate,
    normalizeRevenantWorkflowTerminalStatus,
} = require('../generation.cjs');
const {
    hasRegisteredMainJob,
    isUnregisteredWorkflowExpired,
} = require('./policy.cjs');

function installRevenantWorkflowRoutes(app, deps) {
    const {
        checkProxyAuth,
        requireSyncClientId,
        scheduleHypaWorkflowExecution,
        scheduleRevenantPostprocess = () => {},
        notifyRevenantWorkflowUpdated = () => {},
        terminateGenerationWorkflow,
        cancelGenerationStepExecution,
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
            const input = {
                workflowId: randomUUID(),
                characterId,
                roomId,
                plan,
                context,
            };
            let result = createGenerationWorkflow(input);
            if (result.busy) {
                const jobs = listGenerationWorkflowJobs(result.workflow.workflowId);
                if (isUnregisteredWorkflowExpired(result.workflow, jobs)) {
                    await terminateGenerationWorkflow(result.workflow.workflowId, 'failed');
                    notifyRevenantWorkflowUpdated(getGenerationWorkflow(result.workflow.workflowId));
                    result = createGenerationWorkflow({
                        ...input,
                        workflowId: randomUUID(),
                    });
                }
            }
            if (result.busy) {
                const hasMainJob = hasRegisteredMainJob(
                    listGenerationWorkflowJobs(result.workflow.workflowId),
                );
                res.status(409).send({
                    error: 'A generation workflow is already active for this room',
                    ...(hasMainJob ? { workflow: result.workflow } : {}),
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
        const workflow = getActiveGenerationWorkflow(characterId, roomId);
        if (!workflow) {
            res.send({ workflow: null });
            return;
        }
        const jobs = listGenerationWorkflowJobs(workflow.workflowId);
        if (!hasRegisteredMainJob(jobs)) {
            if (isUnregisteredWorkflowExpired(workflow, jobs)) {
                await terminateGenerationWorkflow(workflow.workflowId, 'failed');
                notifyRevenantWorkflowUpdated(getGenerationWorkflow(workflow.workflowId));
            }
            // Prompt construction and the workflow-to-job registration gap
            // belong only to the submitting page. Other browsers cannot
            // observe or recover this pre-job workflow.
            res.send({ workflow: null });
            return;
        }
        res.send({ workflow });
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
}

module.exports = { installRevenantWorkflowRoutes };

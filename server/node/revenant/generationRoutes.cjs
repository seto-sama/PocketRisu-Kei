'use strict';

const {
    createGenerationWorkflow,
    getGenerationWorkflow,
    getActiveGenerationWorkflow,
    claimGenerationWorkflow,
    updateGenerationWorkflowStep,
    finishGenerationWorkflow,
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
    pruneMaterializedGenerationJobs,
} = require('./generationDb.cjs');
const {
    isRevenantJobActive,
    isValidRevenantWorkflowKey,
    normalizeRevenantJobType,
    normalizeRevenantDispatchPolicy,
    normalizeRevenantHypaExecutionRecipe,
    normalizeRevenantOperationContext,
    normalizeRevenantWorkflowPlan,
    normalizeRevenantWorkflowStepUpdate,
    normalizeRevenantWorkflowTerminalStatus,
} = require('./generation.cjs');
const { createClientGenerationProjection } = require('./generationProjection.cjs');

const WORKFLOW_OWNER_CLAIM_GRACE_MS = 5000;

function installRevenantGenerationRoutes(app, deps) {
    const {
        checkProxyAuth,
        requireSyncClientId,
        sanitizeGenerationTargetUrl,
        normalizeForwardHeaders,
        createProxyStreamJob,
        runProxyStreamJob,
        scheduleGenerationDispatch,
        scheduleHypaWorkflowExecution,
        proxyStreamJobs,
        countActiveProxyStreamJobs,
        maxActiveJobs,
        maxBodyBase64Bytes,
        randomUUID,
        addRequestLog,
        queueStorageOperation,
        chatStorage,
        isSyncClientConnected = () => false,
    } = deps;
    const {
        ensureChatStore,
        getState: getChatStorageState,
        databaseHexKey,
        persistDbCacheWithChats,
        kvGet,
        normalizeJSON,
        decodeRisuSave,
        reassembleFullDb,
        stripChatsFromDb,
        kvSet,
        encodeRisuSaveLegacy,
        initChatStore,
        createBackupAndRotate,
        broadcastDatabaseInvalidated,
    } = chatStorage;

    app.post('/api/generation/workflows', async (req, res, next) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const characterId = typeof req.body?.characterId === 'string' ? req.body.characterId : '';
        const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : '';
        const plan = normalizeRevenantWorkflowPlan(req.body?.plan);
        if (!characterId || !roomId || !plan) {
            res.status(400).send({ error: 'characterId, roomId, and a valid workflow plan are required' });
            return;
        }
        try {
            const result = createGenerationWorkflow({
                workflowId: randomUUID(),
                characterId,
                roomId,
                ownerClientId: String(req.headers['x-sync-client-id'] || ''),
                plan,
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

    app.post('/api/generation/workflows/:workflowId/claim', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const workflow = getGenerationWorkflow(req.params.workflowId);
        if (!workflow || workflow.status !== 'active') {
            res.status(404).send({ error: 'Active generation workflow not found' });
            return;
        }
        const claimant = String(req.headers['x-sync-client-id'] || '');
        if (
            workflow.ownerClientId !== claimant
            && (
                isSyncClientConnected(workflow.ownerClientId)
                || Date.now() - workflow.updatedAt < WORKFLOW_OWNER_CLAIM_GRACE_MS
            )
        ) {
            res.status(409).send({
                error: 'The generation workflow owner is still connected',
                workflow,
            });
            return;
        }
        const claimed = claimGenerationWorkflow(
            workflow.workflowId,
            claimant,
            workflow.ownerClientId,
        );
        if (!claimed) {
            res.status(409).send({
                error: 'Generation workflow ownership changed',
                workflow: getGenerationWorkflow(workflow.workflowId),
            });
            return;
        }
        res.send({ workflow: claimed });
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

    app.post('/api/generation/workflows/:workflowId/finish', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const status = normalizeRevenantWorkflowTerminalStatus(req.body?.status);
        if (!status) {
            res.status(400).send({ error: 'Invalid terminal workflow status' });
            return;
        }
        if (!finishGenerationWorkflow(req.params.workflowId, status)) {
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
        const now = Date.now();
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
        if (
            (workflowId && (
                !isValidRevenantWorkflowKey(workflowId)
                || !isValidRevenantWorkflowKey(workflowStepKey)
            ))
            || (!workflowId && workflowStepKey)
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
        if (!dispatchPolicy && countActiveProxyStreamJobs() >= maxActiveJobs) {
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
        const requestSpec = dispatchPolicy ? {
            targetUrl: url,
            headers: forwardHeaders,
            method,
            bodyBase64,
            timeoutMs: req.body?.timeoutMs,
            heartbeatSec: req.body?.heartbeatSec,
            usageProviderId,
            usageModelId,
            usageServiceTier,
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
                adapterKind: req.body?.adapterKind,
                streaming: req.body?.streaming === true,
                dispatchGroup: dispatchPolicy?.dispatchGroup,
                dispatchMaxConcurrent: dispatchPolicy?.maxConcurrent,
                dispatchRequestsPerMinute: dispatchPolicy?.requestsPerMinute,
                requestSpec,
            });
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
        addRequestLog({
            id: jobId,
            timestamp: now,
            date: new Date(now).toLocaleTimeString(),
            url,
            body: Buffer.from(bodyBase64, 'base64').toString('utf-8'),
            header: JSON.stringify(forwardHeaders, null, 2),
            response: 'Streamed Fetch',
            responseType: 'stream',
            success: true,
            chatId: req.body?.chatId,
            clientId: String(req.headers['x-sync-client-id'] || '').slice(0, 6),
            platform: /Android|iPhone|iPad|iPod|Mobile/i.test(req.headers['user-agent'] || '')
                ? 'Mobile'
                : 'Desktop',
        });
        const job = createProxyStreamJob({
            jobId,
            workflowId,
            heartbeatSec: req.body?.heartbeatSec,
            timeoutMs: req.body?.timeoutMs,
        });
        job.persistent = true;
        if (dispatchPolicy) {
            job.waitingDispatch = true;
            scheduleGenerationDispatch();
        } else {
            job.runPromise = runProxyStreamJob(job, {
                targetUrl: url,
                headers: forwardHeaders,
                method,
                bodyBase64,
                clientIp: req.ip,
                allowExternal: true,
                usageProviderId,
                usageModelId,
                usageServiceTier,
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

    app.post('/api/generation/jobs/prune-materialized', async (req, res, next) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            res.send(pruneMaterializedGenerationJobs());
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
        const job = proxyStreamJobs.get(req.params.jobId);
        if (job && !job.done) {
            job.abortController.abort();
            finishGenerationJob(req.params.jobId, 'cancelled', 'user_cancelled');
        } else {
            const persisted = getGenerationJob(req.params.jobId, false);
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

    app.post('/api/generation/jobs/:jobId/materialize', async (req, res, next) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            await queueStorageOperation(async () => {
                const job = getGenerationJob(req.params.jobId, false);
                if (!job) {
                    res.status(404).send({ error: 'Generation job not found' });
                    return;
                }
                if (job.materializedAt) {
                    res.send({ success: true, alreadyMaterialized: true });
                    return;
                }
                if (!job.characterId || !job.roomId || !job.chatId) {
                    res.status(400).send({ error: 'Generation job has no chat target' });
                    return;
                }
                if (isRevenantJobActive(job.status)) {
                    res.status(409).send({ error: 'Generation job is not complete' });
                    return;
                }
                const earlierJob = listRecoverableGenerationJobs(200).find(candidate =>
                    candidate.jobId !== job.jobId
                    && candidate.characterId === job.characterId
                    && candidate.roomId === job.roomId
                    && candidate.createdAt < job.createdAt
                );
                if (earlierJob) {
                    res.status(409).send({ error: `Earlier generation must materialize first: ${earlierJob.jobId}` });
                    return;
                }
                const incoming = req.body?.message;
                if (!incoming || typeof incoming.data !== 'string') {
                    res.status(400).send({ error: 'Processed generation message is required' });
                    return;
                }

                await ensureChatStore();
                const { fullChatStore, saveTimers, dbCache } = getChatStorageState();
                const storedChat = fullChatStore.get(job.characterId)?.get(job.roomId);
                if (!storedChat || !Array.isArray(storedChat.message)) {
                    res.status(404).send({ error: 'Target chat not found' });
                    return;
                }

                // A streaming chat is not written by the client's normal save
                // loop. Prefer the submitted current snapshot so a user
                // message added immediately before generation is not lost when
                // the final assistant response is materialized.
                const submittedChat = req.body?.chat;
                const chat = submittedChat
                    && submittedChat.id === job.roomId
                    && Array.isArray(submittedChat.message)
                    ? structuredClone(submittedChat)
                    : structuredClone(storedChat);
                const snapshot = job.rerollSnapshot;
                let targetIndex = chat.message.findIndex(message => message?.chatId === job.chatId);
                if (targetIndex < 0 && snapshot) targetIndex = snapshot.targetIndex;
                if (targetIndex < 0 && job.isContinuation) {
                    for (let index = chat.message.length - 1; index >= 0; index--) {
                        if (chat.message[index]?.role === 'char') {
                            targetIndex = index;
                            break;
                        }
                    }
                }

                let materializedMessage;
                if (snapshot) {
                    const current = chat.message[targetIndex];
                    const alreadyCommitted = current?.chatId === job.chatId
                        && Array.isArray(current.swipes)
                        && current.swipes[current.swipeId] === incoming.data;
                    if (alreadyCommitted) {
                        materializedMessage = current;
                    } else {
                        const previousSwipes = Array.isArray(snapshot.targetMessage?.swipes)
                            ? [...snapshot.targetMessage.swipes]
                            : [snapshot.targetMessage?.data ?? ''];
                        materializedMessage = {
                            ...structuredClone(snapshot.targetMessage),
                            ...structuredClone(incoming),
                            role: 'char',
                            data: incoming.data,
                            chatId: job.chatId,
                            swipes: [...previousSwipes, incoming.data],
                            swipeId: previousSwipes.length,
                        };
                        chat.message.splice(
                            Math.max(0, targetIndex),
                            Math.max(0, chat.message.length - Math.max(0, targetIndex)),
                            materializedMessage,
                            ...structuredClone(snapshot.trailingMessages || []),
                        );
                    }
                } else {
                    materializedMessage = {
                        ...(targetIndex >= 0 ? chat.message[targetIndex] : {}),
                        ...structuredClone(incoming),
                        role: incoming.role === 'user' ? 'user' : 'char',
                        data: incoming.data,
                        chatId: job.chatId,
                    };
                    if (targetIndex >= 0) chat.message[targetIndex] = materializedMessage;
                    else chat.message.push(materializedMessage);
                }
                chat.isStreaming = false;

                if (!fullChatStore.has(job.characterId)) {
                    fullChatStore.set(job.characterId, new Map());
                }
                fullChatStore.get(job.characterId).set(job.roomId, chat);
                if (saveTimers[databaseHexKey]) {
                    clearTimeout(saveTimers[databaseHexKey]);
                    delete saveTimers[databaseHexKey];
                }
                if (dbCache[databaseHexKey]) {
                    await persistDbCacheWithChats(databaseHexKey, 'database/database.bin');
                } else {
                    const raw = kvGet('database/database.bin');
                    if (!raw) throw new Error('Compatible database is missing');
                    const dbObj = normalizeJSON(await decodeRisuSave(raw));
                    const fullDb = reassembleFullDb(stripChatsFromDb(dbObj));
                    kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(fullDb)));
                    initChatStore(fullDb);
                }
                createBackupAndRotate();
                if (!markGenerationMaterialized(req.params.jobId)) {
                    throw new Error('Failed to mark generation materialized');
                }
                broadcastDatabaseInvalidated(req, {
                    chats: [{ characterId: job.characterId, chatId: job.roomId }],
                });
                res.send({ success: true, message: materializedMessage, chat });
            });
        } catch (error) {
            next(error);
        }
    });
}

module.exports = {
    installRevenantGenerationRoutes,
};

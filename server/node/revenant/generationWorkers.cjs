'use strict';

const { resolveRevenantWorkflowRequestBody } = require('./generation.cjs');
const { selectHypaMemory } = require('./hypaExecutor.cjs');
const {
    GENERATION_REQUEST_DEFAULT_TIMEOUT_MS,
} = require('./generationConfig.cjs');

function createGenerationWorkers(options) {
    const repository = options.repository || require('./generationDb.cjs');
    const {
        claimGenerationWorkflowExecution,
        claimQueuedGenerationDispatch,
        finishGenerationJob,
        finishGenerationWorkflowExecution,
        getGenerationDispatchState,
        getGenerationWorkflowExecution,
        listGenerationWorkflowJobs,
        listQueuedGenerationDispatches,
        listQueuedGenerationWorkflowExecutions,
        updateGenerationWorkflowStep,
    } = repository;
    const {
        logger,
        generationRuntimeJobs,
        maxActiveJobs,
        countActiveGenerationJobs,
        createGenerationRuntimeJob,
        runGenerationProviderJob,
        markGenerationJobDone,
        sanitizeGenerationTargetUrl,
        embeddingTimeoutMs = GENERATION_REQUEST_DEFAULT_TIMEOUT_MS,
        resolveWorkflowRequestBody = resolveRevenantWorkflowRequestBody,
        selectMemory = selectHypaMemory,
    } = options;

    let dispatchTimer = null;
    let dispatchTimerAt = 0;
    let dispatchRunning = false;
    let dispatchRerunDelayMs;

    function scheduleGenerationDispatch(delayMs = 0) {
        const delay = Math.max(0, Number(delayMs) || 0);
        if (dispatchRunning) {
            dispatchRerunDelayMs = dispatchRerunDelayMs === undefined
                ? delay
                : Math.min(dispatchRerunDelayMs, delay);
            return;
        }
        const at = Date.now() + delay;
        if (dispatchTimer && dispatchTimerAt <= at) return;
        if (dispatchTimer) clearTimeout(dispatchTimer);
        dispatchTimerAt = at;
        dispatchTimer = setTimeout(() => {
            dispatchTimer = null;
            dispatchTimerAt = 0;
            void pumpGenerationDispatchQueue();
        }, delay);
    }

    async function pumpGenerationDispatchQueue() {
        if (dispatchRunning) {
            dispatchRerunDelayMs = 0;
            return;
        }
        dispatchRunning = true;
        let nextWakeMs;
        let retryDelayMs;
        try {
            const queued = listQueuedGenerationDispatches(1000);
            const states = new Map();
            let globalActive = countActiveGenerationJobs();
            for (const item of queued) {
                if (globalActive >= maxActiveJobs) break;
                let preparedRequest = item.requestSpec;
                const workflowDependency = preparedRequest.workflowDependency;
                if (workflowDependency) {
                    const execution = getGenerationWorkflowExecution(item.job.workflowId);
                    // Execution completion explicitly wakes this worker.
                    if (!execution || ['queued', 'running'].includes(execution.status)) continue;
                    if (execution.status !== 'completed') {
                        const message = execution.error || 'HypaV3 workflow selection failed';
                        finishGenerationJob(item.job.jobId, 'failed', 'workflow_dependency_failed', message);
                        const failedJob = generationRuntimeJobs.get(item.job.jobId);
                        if (failedJob) {
                            failedJob.terminalEvent = { type: 'error', status: 502, message };
                            markGenerationJobDone(failedJob);
                        }
                        continue;
                    }
                    try {
                        preparedRequest = {
                            ...preparedRequest,
                            bodyBase64: resolveWorkflowRequestBody(
                                preparedRequest.bodyBase64,
                                workflowDependency,
                                execution,
                            ),
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        finishGenerationJob(item.job.jobId, 'failed', 'workflow_dependency_failed', message);
                        const failedJob = generationRuntimeJobs.get(item.job.jobId);
                        if (failedJob) {
                            failedJob.terminalEvent = { type: 'error', status: 502, message };
                            markGenerationJobDone(failedJob);
                        }
                        continue;
                    }
                }

                let state = states.get(item.dispatchGroup);
                if (!state) {
                    state = getGenerationDispatchState(
                        item.dispatchGroup,
                        Date.now() - 60 * 1000,
                    );
                    states.set(item.dispatchGroup, state);
                }
                // Running job completion explicitly wakes this worker.
                if (state.active >= item.maxConcurrent) continue;
                if (state.recent >= item.requestsPerMinute) {
                    if (state.oldestRecent) {
                        const wait = Math.max(100, state.oldestRecent + 60 * 1000 - Date.now());
                        nextWakeMs = nextWakeMs === undefined ? wait : Math.min(nextWakeMs, wait);
                    }
                    continue;
                }

                const claimed = claimQueuedGenerationDispatch(item.job.jobId);
                if (!claimed) continue;
                const request = workflowDependency ? preparedRequest : claimed.requestSpec;
                let job = generationRuntimeJobs.get(item.job.jobId);
                if (!job) {
                    job = createGenerationRuntimeJob({
                        jobId: item.job.jobId,
                        workflowId: item.job.workflowId,
                        heartbeatSec: request.heartbeatSec,
                        timeoutMs: request.timeoutMs,
                    });
                }
                job.waitingDispatch = false;
                job.done = false;
                job.terminalEvent = null;
                job.providerStartedAt = claimed.job.dispatchedAt;
                job.updatedAt = Date.now();
                job.deadlineAt = Date.now() + job.timeoutMs;
                job.runPromise = runGenerationProviderJob(job, {
                    targetUrl: request.targetUrl,
                    headers: request.headers,
                    method: request.method,
                    bodyBase64: request.bodyBase64,
                    usageProviderId: request.usageProviderId,
                    usageModelId: request.usageModelId,
                    usageServiceTier: request.usageServiceTier,
                    requestLog: request.requestLog,
                });
                void job.runPromise.finally(() => {
                    scheduleGenerationDispatch();
                    scheduleHypaWorkflowExecution();
                });
                state.active += 1;
                state.recent += 1;
                state.oldestRecent ??= Date.now();
                globalActive += 1;
            }
            if (nextWakeMs !== undefined) scheduleGenerationDispatch(nextWakeMs);
        } catch (error) {
            logger.error('[GenerationDispatch] Failed to pump durable queue:', error);
            retryDelayMs = 1000;
        } finally {
            dispatchRunning = false;
            const rerunDelayMs = dispatchRerunDelayMs;
            dispatchRerunDelayMs = undefined;
            if (rerunDelayMs !== undefined || retryDelayMs !== undefined) {
                scheduleGenerationDispatch(Math.min(
                    rerunDelayMs ?? Number.POSITIVE_INFINITY,
                    retryDelayMs ?? Number.POSITIVE_INFINITY,
                ));
            }
        }
    }

    let hypaTimer = null;
    let hypaRunning = false;
    let hypaRerunRequested = false;
    const hypaRuns = new Map();

    function scheduleHypaWorkflowExecution(delayMs = 0) {
        if (hypaRunning) {
            hypaRerunRequested = true;
            return;
        }
        if (hypaTimer) return;
        hypaTimer = setTimeout(() => {
            hypaTimer = null;
            void pumpHypaWorkflowExecutions();
        }, Math.max(0, Number(delayMs) || 0));
    }

    function abortHypaWorkflowExecution(workflowId) {
        const run = hypaRuns.get(workflowId);
        if (!run) return undefined;
        run.controller.abort(new Error('workflow_cancelled'));
        return run.settled;
    }

    async function pumpHypaWorkflowExecutions() {
        if (hypaRunning) {
            hypaRerunRequested = true;
            return;
        }
        hypaRunning = true;
        let retryDelayMs;
        try {
            for (const item of listQueuedGenerationWorkflowExecutions(20)) {
                const recipe = item.recipe;
                const expectedIds = new Set(recipe.expectedOperationIds);
                const jobs = listGenerationWorkflowJobs(item.workflowId).filter(job =>
                    job.operationContext?.kind === 'hypav3-summary'
                    && job.operationContext.batchId === recipe.batchId
                    && expectedIds.has(job.operationContext.operationId));
                // Job creation/completion explicitly wakes this worker.
                if (jobs.length < expectedIds.size || jobs.some(job =>
                    job.status === 'queued' || job.status === 'generating')) continue;

                const failed = jobs.find(job => job.status !== 'generated');
                if (failed) {
                    const error = `Hypa summary ${failed.jobId} ended as ${failed.status}`;
                    finishGenerationWorkflowExecution(item.workflowId, 'failed', null, error);
                    updateGenerationWorkflowStep(item.workflowId, 'memory.hypav3', {
                        status: 'failed',
                        metadata: { checkpoint: 'selection.remote', error },
                    });
                    scheduleGenerationDispatch();
                    continue;
                }
                if (jobs.some(job => !job.projection?.content?.trim())) {
                    const error = 'Hypa summary projection is unavailable';
                    finishGenerationWorkflowExecution(item.workflowId, 'failed', null, error);
                    updateGenerationWorkflowStep(item.workflowId, 'memory.hypav3', {
                        status: 'failed',
                        metadata: { checkpoint: 'selection.remote', error },
                    });
                    scheduleGenerationDispatch();
                    continue;
                }
                if (!claimGenerationWorkflowExecution(item.workflowId)) continue;

                const controller = new AbortController();
                let resolveSettled;
                const settled = new Promise(resolve => { resolveSettled = resolve; });
                const timeout = setTimeout(
                    () => controller.abort(new Error('HypaV3 embedding timed out')),
                    Math.max(1, Number(embeddingTimeoutMs)
                        || GENERATION_REQUEST_DEFAULT_TIMEOUT_MS),
                );
                hypaRuns.set(item.workflowId, { controller, settled });
                try {
                    const byOperation = new Map(jobs.map(job => [
                        job.operationContext.operationId,
                        job,
                    ]));
                    const summaries = [
                        ...recipe.memory.summaries,
                        ...recipe.expectedOperationIds.map(operationId => {
                            const job = byOperation.get(operationId);
                            return {
                                text: job.projection.content
                                    .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, '')
                                    .trim(),
                                chatMemos: [...job.operationContext.chatMemos],
                                isImportant: false,
                            };
                        }),
                    ];
                    const result = await selectMemory(recipe, summaries, {
                        sanitizeUrl: sanitizeGenerationTargetUrl,
                        signal: controller.signal,
                    });
                    finishGenerationWorkflowExecution(item.workflowId, 'completed', result, null);
                    updateGenerationWorkflowStep(item.workflowId, 'memory.hypav3', {
                        status: 'completed',
                        metadata: {
                            checkpoint: 'selection.remote',
                            embeddingModel: recipe.embedding.model,
                            chatSequence: result.chatSequence,
                            currentTokens: result.currentTokens,
                            hypaMemory: result.memory,
                        },
                    });
                    scheduleGenerationDispatch();
                } catch (error) {
                    const message = controller.signal.aborted
                        ? String(controller.signal.reason?.message || 'HypaV3 embedding aborted')
                        : error instanceof Error ? error.message : String(error);
                    finishGenerationWorkflowExecution(item.workflowId, 'failed', null, message);
                    updateGenerationWorkflowStep(item.workflowId, 'memory.hypav3', {
                        status: 'failed',
                        metadata: { checkpoint: 'selection.remote', error: message },
                    });
                    scheduleGenerationDispatch();
                    if (message !== 'workflow_cancelled') {
                        logger.error(`[HypaWorkflow] ${item.workflowId} failed:`, error);
                    }
                } finally {
                    clearTimeout(timeout);
                    resolveSettled();
                    if (hypaRuns.get(item.workflowId)?.controller === controller) {
                        hypaRuns.delete(item.workflowId);
                    }
                }
            }
        } catch (error) {
            logger.error('[HypaWorkflow] Failed to pump executions:', error);
            retryDelayMs = 1000;
        } finally {
            hypaRunning = false;
            if (hypaRerunRequested) {
                hypaRerunRequested = false;
                scheduleHypaWorkflowExecution();
            }
            else if (retryDelayMs !== undefined) {
                scheduleHypaWorkflowExecution(retryDelayMs);
            }
        }
    }

    return {
        abortHypaWorkflowExecution,
        scheduleGenerationDispatch,
        scheduleHypaWorkflowExecution,
    };
}

module.exports = { createGenerationWorkers };

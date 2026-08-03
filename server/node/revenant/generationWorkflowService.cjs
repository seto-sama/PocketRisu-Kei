'use strict';

function createGenerationWorkflowService(options) {
    const {
        finishGenerationWorkflow,
        cancelGenerationWorkflow,
        cancelGenerationStepExecution = () => ({ changed: false, jobs: [] }),
        generationRuntimeJobs,
        markGenerationJobDone,
        abortHypaWorkflowExecution = () => {},
    } = options;

    async function abortJobs(jobs, terminalEvent) {
        const abortWaiters = [];
        for (const item of jobs) {
            const job = generationRuntimeJobs.get(item.jobId);
            if (!job || job.done) continue;
            job.abortController.abort();
            const upstreamAbort = job.cancelUpstream?.(job.abortController.signal.reason);
            if (upstreamAbort && typeof upstreamAbort.then === 'function') {
                abortWaiters.push(upstreamAbort);
            }

            // A queued job has no provider runner that can publish its terminal
            // state. Running jobs publish after their journal writer closes.
            if (item.status === 'queued' || !job.runPromise) {
                job.terminalEvent = terminalEvent;
                markGenerationJobDone(job);
            }
            else if (job.runPromise && typeof job.runPromise.then === 'function') {
                abortWaiters.push(job.runPromise);
            }
        }
        await Promise.allSettled(abortWaiters);
    }

    async function terminateWorkflow(workflowId, status) {
        if (status === 'completed') {
            return {
                changed: finishGenerationWorkflow(workflowId, status),
                jobs: [],
            };
        }

        const result = cancelGenerationWorkflow(workflowId, status);
        if (!result.changed) return result;

        const hypaAbort = abortHypaWorkflowExecution(workflowId);
        await Promise.allSettled([
            abortJobs(result.jobs, status === 'cancelled'
                ? {
                    type: 'done',
                    partial: true,
                    finishReason: 'workflow_cancelled',
                }
                : {
                    type: 'error',
                    status: 502,
                    message: 'Generation workflow failed',
                }),
            ...(hypaAbort && typeof hypaAbort.then === 'function' ? [hypaAbort] : []),
        ]);
        return result;
    }

    async function cancelStepExecution(workflowId, executionId) {
        const result = cancelGenerationStepExecution(workflowId, executionId);
        if (!result.changed) return result;
        await abortJobs(result.jobs, {
            type: 'done',
            partial: true,
            finishReason: 'step_cancelled',
        });
        return result;
    }

    return { terminateWorkflow, cancelStepExecution };
}

module.exports = { createGenerationWorkflowService };

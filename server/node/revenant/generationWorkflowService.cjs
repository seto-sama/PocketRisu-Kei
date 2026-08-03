'use strict';

function createGenerationWorkflowService(options) {
    const {
        finishGenerationWorkflow,
        cancelGenerationWorkflow,
        proxyStreamJobs,
        markJobDone,
        abortHypaWorkflowExecution = () => {},
    } = options;

    async function terminateWorkflow(workflowId, status) {
        if (status === 'completed') {
            return {
                changed: finishGenerationWorkflow(workflowId, status),
                jobs: [],
            };
        }

        const result = cancelGenerationWorkflow(workflowId, status);
        if (!result.changed) return result;

        const abortWaiters = [];
        const hypaAbort = abortHypaWorkflowExecution(workflowId);
        if (hypaAbort && typeof hypaAbort.then === 'function') abortWaiters.push(hypaAbort);
        for (const item of result.jobs) {
            const job = proxyStreamJobs.get(item.jobId);
            if (!job || job.done) continue;
            job.abortController.abort();
            const upstreamAbort = job.cancelUpstream?.(job.abortController.signal.reason);
            if (upstreamAbort && typeof upstreamAbort.then === 'function') {
                abortWaiters.push(upstreamAbort);
            }

            // A queued job has no provider runner that can publish its terminal
            // state. Running jobs publish after their journal writer closes.
            if (item.status === 'queued' || !job.runPromise) {
                job.terminalEvent = status === 'cancelled'
                    ? {
                        type: 'done',
                        partial: true,
                        finishReason: 'workflow_cancelled',
                    }
                    : {
                        type: 'error',
                        status: 502,
                        message: 'Generation workflow failed',
                };
                markJobDone(job);
            }
            else if (job.runPromise && typeof job.runPromise.then === 'function') {
                abortWaiters.push(job.runPromise);
            }
        }
        await Promise.allSettled(abortWaiters);
        return result;
    }

    return { terminateWorkflow };
}

module.exports = { createGenerationWorkflowService };

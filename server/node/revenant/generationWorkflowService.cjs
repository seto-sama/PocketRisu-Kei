'use strict';

function createGenerationWorkflowService(options) {
    const {
        finishGenerationWorkflow,
        cancelGenerationWorkflow,
        cancelGenerationStepExecution = () => ({ changed: false, jobs: [] }),
        generationRuntimeJobs,
        markGenerationJobDone,
        abortHypaWorkflowExecution = () => {},
        commitWorkflowInput = async () => {
            throw new Error('Workflow input commit service unavailable');
        },
        updateGenerationWorkflowStep = () => false,
        getGenerationWorkflow = workflow => workflow,
        materializeCancelledWorkflow = async () => {},
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
        if (!result.changed) {
            if (status === 'cancelled') {
                await materializeCancelledWorkflow(workflowId);
            }
            return result;
        }

        const hypaAbort = abortHypaWorkflowExecution(workflowId);
        await Promise.allSettled([
            abortJobs(result.jobs, status === 'cancelled'
                ? {
                    type: 'done',
                    status: 'cancelled',
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
        if (status === 'cancelled') {
            await materializeCancelledWorkflow(workflowId);
        }
        return result;
    }

    async function cancelStepExecution(workflowId, executionId) {
        const result = cancelGenerationStepExecution(workflowId, executionId);
        if (!result.changed) return result;
        await abortJobs(result.jobs, {
            type: 'done',
            status: 'cancelled',
            partial: true,
            finishReason: 'step_cancelled',
        });
        return result;
    }

    async function commitInput(workflow, input, request) {
        const step = workflow?.steps?.find(item => item.key === 'input.commit');
        if (!step || step.status !== 'pending') {
            const error = new Error('input.commit must be the pending workflow input boundary');
            error.httpStatus = 400;
            throw error;
        }
        try {
            const commit = await commitWorkflowInput({
                workflowId: workflow.workflowId,
                characterId: workflow.characterId,
                roomId: workflow.roomId,
                input,
                request,
            });
            updateGenerationWorkflowStep(workflow.workflowId, 'input.commit', {
                status: 'completed',
                metadata: {
                    schemaVersion: 1,
                    ...(commit?.etag ? { etag: commit.etag } : {}),
                },
            });
            return getGenerationWorkflow(workflow.workflowId);
        } catch (error) {
            updateGenerationWorkflowStep(workflow.workflowId, 'input.commit', {
                status: 'failed',
                metadata: { error: error?.message || 'Failed to commit workflow input' },
            });
            await terminateWorkflow(workflow.workflowId, 'failed');
            throw error;
        }
    }

    return { terminateWorkflow, cancelStepExecution, commitInput };
}

module.exports = { createGenerationWorkflowService };

'use strict';

const {
    runRevenantOutputStage,
    runRevenantOutputTransform,
    runRevenantTriggerStage,
} = require('./postprocessPipeline.cjs');

function createRevenantPostprocessWorker(options) {
    const repository = options.repository || require('./generationDb.cjs');
    const {
        claimGenerationWorkflowStep,
        getGenerationWorkflow,
        listReadyChatWorkflowJobs,
        updateGenerationWorkflowStep,
    } = repository;
    const {
        logger = console,
        transformOutput = runRevenantOutputTransform,
        runOutputStage = runRevenantOutputStage,
        runTriggerStage = runRevenantTriggerStage,
    } = options;
    let timer = null;
    let running = false;
    let rerun = false;

    function schedule(delayMs = 0) {
        if (running) {
            rerun = true;
            return;
        }
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            void pump();
        }, Math.max(0, Number(delayMs) || 0));
    }

    async function pump() {
        if (running) {
            rerun = true;
            return;
        }
        running = true;
        let retry = false;
        try {
            for (const job of listReadyChatWorkflowJobs(20)) {
                const workflow = getGenerationWorkflow(job.workflowId);
                if (workflow?.context?.kind !== 'chat-generation') continue;
                let outputStep = workflow.steps.find(step => step.key === 'output.transform');
                if (outputStep?.status === 'pending'
                    && claimGenerationWorkflowStep(workflow.workflowId, 'output.transform', 'pending')) {
                    try {
                        const prefix = job.isContinuation ? job.continuationPrefix || '' : '';
                        const result = await runOutputStage({
                            text: `${prefix}${job.projection.content}`.trim(),
                            recipe: workflow.context.postprocess,
                            job,
                            responses: outputStep.metadata?.responses,
                            transformOutput,
                        });
                        updateGenerationWorkflowStep(workflow.workflowId, 'output.transform', {
                            status: result.status === 'waiting_client' ? 'waiting_client' : 'completed',
                            metadata: {
                                schemaVersion: 1,
                                ...(outputStep.metadata?.responses
                                    ? { responses: outputStep.metadata.responses }
                                    : {}),
                                ...result,
                            },
                        });
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        updateGenerationWorkflowStep(workflow.workflowId, 'output.transform', {
                            status: 'failed',
                            metadata: { schemaVersion: 1, error: message },
                        });
                        logger.error(`[Revenant] Output transform failed for ${workflow.workflowId}:`, error);
                    }
                    outputStep = getGenerationWorkflow(workflow.workflowId)?.steps
                        ?.find(step => step.key === 'output.transform');
                }
                if (outputStep?.status !== 'completed') continue;

                let triggerStep = getGenerationWorkflow(workflow.workflowId)?.steps
                    ?.find(step => step.key === 'trigger.output');
                if (triggerStep?.status !== 'pending'
                    || !claimGenerationWorkflowStep(workflow.workflowId, 'trigger.output', 'pending')) continue;
                try {
                    const result = await runTriggerStage({
                        recipe: workflow.context.postprocess,
                        text: outputStep.metadata.text,
                        chat: outputStep.metadata.chat,
                        responses: triggerStep.metadata?.responses,
                    });
                    updateGenerationWorkflowStep(workflow.workflowId, 'trigger.output', {
                        status: result.status === 'waiting_client' ? 'waiting_client' : 'completed',
                        metadata: {
                            schemaVersion: 1,
                            ...(triggerStep.metadata?.responses
                                ? { responses: triggerStep.metadata.responses }
                                : {}),
                            ...result,
                        },
                    });
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    updateGenerationWorkflowStep(workflow.workflowId, 'trigger.output', {
                        status: 'failed',
                        metadata: { schemaVersion: 1, error: message },
                    });
                    logger.error(`[Revenant] Output trigger failed for ${workflow.workflowId}:`, error);
                }
            }
        }
        catch (error) {
            retry = true;
            logger.error('[Revenant] Failed to pump postprocess workflows:', error);
        }
        finally {
            running = false;
            if (rerun || retry) {
                rerun = false;
                schedule(retry ? 1000 : 0);
            }
        }
    }

    return { pump, schedule };
}

module.exports = { createRevenantPostprocessWorker };

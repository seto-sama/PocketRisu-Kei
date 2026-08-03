'use strict';

const path = require('path');

require('sucrase/register/ts');
const { runRevenantOutputTransform } = require(path.join(
    __dirname,
    '..',
    '..',
    '..',
    'src',
    'ts',
    'process',
    'revenant',
    'postprocess.ts',
));

function createRevenantPostprocessWorker(options) {
    const repository = options.repository || require('./generationDb.cjs');
    const {
        claimGenerationWorkflowStep,
        getGenerationWorkflow,
        listReadyChatWorkflowJobs,
        updateGenerationWorkflowStep,
    } = repository;
    const { logger = console, transformOutput = runRevenantOutputTransform } = options;
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
                const outputStep = workflow.steps.find(step => step.key === 'output.transform');
                if (outputStep?.status !== 'pending') continue;
                if (!claimGenerationWorkflowStep(workflow.workflowId, 'output.transform', 'pending')) continue;
                try {
                    const prefix = job.isContinuation ? job.continuationPrefix || '' : '';
                    const result = await transformOutput(
                        `${prefix}${job.projection.content}`.trim(),
                        workflow.context.postprocess,
                    );
                    updateGenerationWorkflowStep(workflow.workflowId, 'output.transform', {
                        status: 'completed',
                        metadata: {
                            schemaVersion: 1,
                            text: result.text,
                            chat: result.chat,
                            foregroundEffects: result.foregroundEffects,
                            errors: result.errors,
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

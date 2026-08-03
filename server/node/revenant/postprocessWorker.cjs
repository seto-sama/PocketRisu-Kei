'use strict';

const {
    runRevenantOutputStage,
    runRevenantOutputTransform,
    runRevenantTriggerStage,
    renderRevenantPostprocessPrompt,
} = require('./postprocessPipeline.cjs');

function recipeWithMutations(recipe, ...patches) {
    const result = structuredClone(recipe);
    for (const patch of patches) {
        if (patch?.character) Object.assign(result.character, structuredClone(patch.character));
        if (patch?.database) Object.assign(result.database, structuredClone(patch.database));
    }
    return result;
}

function createRevenantPostprocessWorker(options) {
    const repository = options.repository || require('./generationDb.cjs');
    const {
        claimGenerationWorkflowStep,
        getGenerationWorkflow,
        finishGenerationWorkflow,
        listReadyChatWorkflowJobs,
        updateGenerationWorkflowStep,
    } = repository;
    const {
        logger = console,
        transformOutput = runRevenantOutputTransform,
        runOutputStage = runRevenantOutputStage,
        runTriggerStage = runRevenantTriggerStage,
        renderPrompt = renderRevenantPostprocessPrompt,
        materializeGeneration = async () => {
            throw new Error('Revenant materializer is not configured');
        },
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
                        finishGenerationWorkflow(workflow.workflowId, 'failed');
                        logger.error(`[Revenant] Output transform failed for ${workflow.workflowId}:`, error);
                    }
                    outputStep = getGenerationWorkflow(workflow.workflowId)?.steps
                        ?.find(step => step.key === 'output.transform');
                }
                if (outputStep?.status !== 'completed') continue;

                let triggerStep = getGenerationWorkflow(workflow.workflowId)?.steps
                    ?.find(step => step.key === 'trigger.output');
                if (triggerStep?.status === 'pending'
                    && claimGenerationWorkflowStep(workflow.workflowId, 'trigger.output', 'pending')) {
                    try {
                        const result = await runTriggerStage({
                            recipe: recipeWithMutations(
                                workflow.context.postprocess,
                                outputStep.metadata.mutations,
                            ),
                            text: outputStep.metadata.text,
                            chat: outputStep.metadata.chat,
                            responses: triggerStep.metadata?.responses,
                        });
                        if (result.status !== 'waiting_client' && result.errors?.length > 0) {
                            throw new Error(result.errors.join('\n'));
                        }
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
                        finishGenerationWorkflow(workflow.workflowId, 'failed');
                        logger.error(`[Revenant] Output trigger failed for ${workflow.workflowId}:`, error);
                    }
                }
                triggerStep = getGenerationWorkflow(workflow.workflowId)?.steps
                    ?.find(step => step.key === 'trigger.output');
                if (triggerStep?.status !== 'completed') continue;

                let currentChat = triggerStep.metadata.chat;
                let igpStep = getGenerationWorkflow(workflow.workflowId)?.steps
                    ?.find(step => step.key === 'igp');
                if (igpStep?.status === 'pending'
                    && claimGenerationWorkflowStep(workflow.workflowId, 'igp', 'pending')) {
                    const rawPrompt = String(
                        workflow.context.postprocess.database?.igpPrompt || '',
                    ).trim();
                    const effectiveRecipe = recipeWithMutations(
                        workflow.context.postprocess,
                        outputStep.metadata.mutations,
                        triggerStep.metadata.mutations,
                    );
                    const prompt = rawPrompt
                        ? renderPrompt(rawPrompt, effectiveRecipe, currentChat).trim()
                        : '';
                    const igpProvider = effectiveRecipe.auxProviders?.emotion;
                    if (!prompt) {
                        updateGenerationWorkflowStep(workflow.workflowId, 'igp', {
                            status: 'skipped', metadata: { schemaVersion: 1, chat: currentChat },
                        });
                    }
                    else if (!igpProvider) {
                        updateGenerationWorkflowStep(workflow.workflowId, 'igp', {
                            status: 'skipped',
                            metadata: {
                                schemaVersion: 1,
                                chat: currentChat,
                                error: 'IGP model preset is not configured',
                            },
                        });
                    }
                    else {
                        const actionId = 'igp.provider';
                        const response = igpStep.metadata?.responses?.[actionId];
                        if (response === undefined) {
                            updateGenerationWorkflowStep(workflow.workflowId, 'igp', {
                                status: 'waiting_client',
                                metadata: {
                                    schemaVersion: 1,
                                    ...(igpStep.metadata?.responses
                                        ? { responses: igpStep.metadata.responses }
                                        : {}),
                                    action: {
                                        schemaVersion: 1,
                                        actionId,
                                        kind: 'provider.igp',
                                        payload: {
                                            backend: igpProvider.backend,
                                            modelPreset: igpProvider.modelPreset,
                                            prompt,
                                        },
                                    },
                                },
                            });
                        }
                        else if (response?.success !== true || typeof response.result !== 'string') {
                            updateGenerationWorkflowStep(workflow.workflowId, 'igp', {
                                status: 'skipped',
                                metadata: {
                                    schemaVersion: 1, chat: currentChat,
                                    error: String(response?.result || 'IGP provider request failed'),
                                },
                            });
                        }
                        else {
                            currentChat = structuredClone(currentChat);
                            const target = currentChat.message.findLast(message => message?.role === 'char');
                            if (target) target.data += response.result;
                            updateGenerationWorkflowStep(workflow.workflowId, 'igp', {
                                status: 'completed',
                                metadata: {
                                    schemaVersion: 1, chat: currentChat,
                                    responses: igpStep.metadata.responses,
                                },
                            });
                        }
                    }
                    igpStep = getGenerationWorkflow(workflow.workflowId)?.steps
                        ?.find(step => step.key === 'igp');
                }
                if (!['completed', 'skipped'].includes(igpStep?.status)) continue;
                currentChat = igpStep.metadata?.chat || currentChat;

                const foregroundEffects = [
                    ...(outputStep.metadata.foregroundEffects || []),
                    ...(triggerStep.metadata.foregroundEffects || []),
                ];
                const finalMessage = [...(currentChat.message || [])]
                    .reverse()
                    .find(message => message?.role === 'char');
                if (
                    workflow.context.postprocess.character?.inlayViewScreen
                    && finalMessage?.data
                ) {
                    foregroundEffects.push({ kind: 'inlay.screen' });
                }
                const explicitEmotion = foregroundEffects.some(effect => effect?.kind === 'emotion');
                const emotionProvider = workflow.context.postprocess.auxProviders?.emotion;
                if (
                    !workflow.context.postprocess.character?.inlayViewScreen
                    && workflow.context.postprocess.character?.viewScreen === 'emotion'
                    && !explicitEmotion
                    && finalMessage?.data
                    && (workflow.context.postprocess.database?.emotionProcesser === 'embedding'
                        || emotionProvider)
                ) {
                    foregroundEffects.push({
                        kind: 'emotion.auto',
                        text: finalMessage.data,
                        processor: workflow.context.postprocess.database?.emotionProcesser || 'submodel',
                        prompt: workflow.context.postprocess.database?.emotionPrompt2 || '',
                        ...(emotionProvider ? { provider: emotionProvider } : {}),
                    });
                }
                if (workflow.context.postprocess.database?.notification && finalMessage?.data) {
                    foregroundEffects.push({ kind: 'notification', text: finalMessage.data });
                }
                if (
                    workflow.context.postprocess.database?.ttsEnabled
                    && workflow.context.postprocess.database?.ttsAutoSpeech
                    && finalMessage?.data
                ) {
                    foregroundEffects.push({ kind: 'tts', text: finalMessage.data });
                }
                if (triggerStep.metadata?.resend === true) {
                    foregroundEffects.push({ kind: 'chat.resend' });
                }
                let foregroundStep = getGenerationWorkflow(workflow.workflowId)?.steps
                    ?.find(step => step.key === 'postprocess');
                if (foregroundStep?.status === 'pending'
                    && claimGenerationWorkflowStep(workflow.workflowId, 'postprocess', 'pending')) {
                    const actionId = 'postprocess.ui-effects';
                    const response = foregroundStep.metadata?.responses?.[actionId];
                    const acknowledged = response !== undefined;
                    if (foregroundEffects.length > 0 && !acknowledged) {
                        updateGenerationWorkflowStep(workflow.workflowId, 'postprocess', {
                            status: 'waiting_client',
                            metadata: {
                                schemaVersion: 1,
                                ...(foregroundStep.metadata?.responses
                                    ? { responses: foregroundStep.metadata.responses }
                                    : {}),
                                chat: currentChat,
                                action: {
                                    schemaVersion: 1,
                                    actionId,
                                    kind: 'ui.effects',
                                    payload: { effects: foregroundEffects, chat: currentChat },
                                },
                            },
                        });
                    }
                    else {
                        if (
                            response?.chat?.id === currentChat.id
                            && Array.isArray(response.chat.message)
                        ) currentChat = structuredClone(response.chat);
                        updateGenerationWorkflowStep(workflow.workflowId, 'postprocess', {
                            status: 'completed',
                            metadata: {
                                schemaVersion: 1, chat: currentChat, foregroundEffects,
                                ...(foregroundStep.metadata?.responses
                                    ? { responses: foregroundStep.metadata.responses }
                                    : {}),
                            },
                        });
                    }
                    foregroundStep = getGenerationWorkflow(workflow.workflowId)?.steps
                        ?.find(step => step.key === 'postprocess');
                }
                if (foregroundStep?.status !== 'completed') continue;

                const materializeStep = getGenerationWorkflow(workflow.workflowId)?.steps
                    ?.find(step => step.key === 'message.materialize');
                if (materializeStep?.status === 'completed') {
                    finishGenerationWorkflow(workflow.workflowId, 'completed');
                    continue;
                }
                if (materializeStep?.status !== 'pending'
                    || !claimGenerationWorkflowStep(
                        workflow.workflowId,
                        'message.materialize',
                        'pending',
                    )) continue;
                try {
                    await materializeGeneration(job.jobId);
                    finishGenerationWorkflow(workflow.workflowId, 'completed');
                }
                catch (error) {
                    retry = true;
                    updateGenerationWorkflowStep(workflow.workflowId, 'message.materialize', {
                        status: 'pending',
                        metadata: {
                            schemaVersion: 1,
                            error: error instanceof Error ? error.message : String(error),
                        },
                    });
                    logger.error(`[Revenant] Materialization failed for ${workflow.workflowId}:`, error);
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

'use strict';

const { applyRevenantStageTimingToMessage } = require('./generationTiming.cjs');
const { applyGeneratedMessage } = require('./postprocessPipeline.cjs');
const { resolveRevenantPostprocessRecipe } = require('./generation.cjs');
const { apiErrorMessage, codes } = require('../utils/apiErrors.cjs');
const {
    isGenerationProjectionCurrent,
    projectGenerationJournal,
} = require('./generationProjection.cjs');

class RevenantMaterializationError extends Error {
    constructor(status, message, options = {}) {
        super(message);
        this.name = 'RevenantMaterializationError';
        this.status = status;
        this.conflicts = options.conflicts;
        this.action = options.action;
        this.cancelled = options.cancelled;
    }
}

function completedServerChat(steps) {
    for (const key of ['message.materialize', 'postprocess', 'igp', 'trigger.output', 'output.transform']) {
        const step = steps.get(key);
        if (step?.status === 'completed' && step.metadata?.chat?.id && Array.isArray(step.metadata.chat.message)) {
            return step.metadata.chat;
        }
    }
    return undefined;
}

function completedServerMutationPatch(steps) {
    const patch = {};
    for (const key of ['output.transform', 'trigger.output', 'igp', 'postprocess']) {
        const step = steps.get(key);
        if (step?.status !== 'completed') continue;
        for (const scope of ['character', 'database']) {
            const fields = step.metadata?.mutations?.[scope];
            if (fields && typeof fields === 'object') patch[scope] = { ...patch[scope], ...fields };
        }
    }
    return Object.keys(patch).length > 0 ? structuredClone(patch) : undefined;
}

function applyMutationPatch(database, characterId, patch) {
    if (!database || !patch) return false;
    let changed = false;
    if (patch.character && typeof patch.character === 'object') {
        const character = database.characters?.find(item => item?.chaId === characterId);
        if (character) {
            for (const field of [
                'name', 'desc', 'firstMessage', 'backgroundHTML',
                'replaceGlobalNote', 'globalLore',
            ]) {
                if (Object.prototype.hasOwnProperty.call(patch.character, field)) {
                    character[field] = structuredClone(patch.character[field]);
                    changed = true;
                }
            }
        }
    }
    if (patch.database && typeof patch.database === 'object') {
        for (const field of ['personaPrompt', 'personas', 'globalChatVariables']) {
            if (Object.prototype.hasOwnProperty.call(patch.database, field)) {
                database[field] = structuredClone(patch.database[field]);
                changed = true;
            }
        }
    }
    return changed;
}

function createRevenantMaterializer(options) {
    const repository = options.repository || require('./generationDb.cjs');
    const {
        getGenerationJob,
        getGenerationWorkflow,
        getGenerationWorkflowInputChat,
        listGenerationWorkflowJobs,
        getEarlierRecoverableGenerationWorkflowJob,
        markGenerationMaterialized,
        readGenerationJobRaw = () => Buffer.alloc(0),
        setGenerationJobProjection = () => false,
        setGenerationJobProjectionError = () => false,
        updateGenerationWorkflowStep,
    } = repository;
    const { canonicalChatService } = options;

    async function commitGenerationResult(args) {
        try {
            return await canonicalChatService.commitGenerationResult(args);
        } catch (error) {
            if (Number.isInteger(error?.httpStatus)) {
                throw new RevenantMaterializationError(error.httpStatus, error.message, {
                    conflicts: error.conflicts,
                    action: error.action,
                    cancelled: error.cancelled,
                });
            }
            throw error;
        }
    }

    function cancellationOwnsEveryConflict(job, error, recipe) {
        if (error?.status !== 409 || !Array.isArray(error.conflicts) || error.conflicts.length === 0) {
            return false;
        }
        const ownedPaths = new Set([
            job.chatId,
            recipe?.rerollSnapshot?.targetMessage?.chatId,
        ].filter(Boolean).map(id => `/message/${id}`));
        return error.conflicts.every(path => ownedPaths.has(path));
    }

    async function drainEarlierCancelledGenerations(job) {
        let earlierJob = getEarlierRecoverableGenerationWorkflowJob(
            job.characterId,
            job.roomId,
            job.createdAt,
        );
        while (earlierJob) {
            const earlierWorkflow = getGenerationWorkflow(earlierJob.workflowId);
            if (earlierWorkflow?.status !== 'cancelled') {
                throw new RevenantMaterializationError(
                    409,
                    `Earlier generation must materialize first: ${earlierJob.jobId}`,
                );
            }
            await materializeCancelledJob(earlierWorkflow, earlierJob);
            if (!getGenerationJob(earlierJob.jobId, false)?.materializedAt) {
                throw new RevenantMaterializationError(
                    409,
                    `Earlier generation must materialize first: ${earlierJob.jobId}`,
                );
            }
            earlierJob = getEarlierRecoverableGenerationWorkflowJob(
                job.characterId,
                job.roomId,
                job.createdAt,
            );
        }
    }

    async function materialize(jobId) {
        const job = getGenerationJob(jobId, false);
        if (!job) {
            throw new RevenantMaterializationError(
                404,
                apiErrorMessage(codes.REVENANT_JOB_NOT_FOUND),
            );
        }
        if (job.materializedAt) return { success: true, alreadyMaterialized: true };
        if (!job.characterId || !job.roomId || !job.chatId) {
            throw new RevenantMaterializationError(400, 'Generation job has no chat target');
        }
        if (['queued', 'generating'].includes(job.status)) {
            throw new RevenantMaterializationError(409, 'Generation job is not complete');
        }
        // Cancelled workflows are not part of the ordinary postprocess queue.
        // A crash or cancellation/materialization race can therefore leave an
        // older partial result pending forever. Drain that durable cancellation
        // before committing the newer response so room ordering can progress.
        await drainEarlierCancelledGenerations(job);

        const workflow = job.workflowId ? getGenerationWorkflow(job.workflowId) : undefined;
        const steps = new Map((workflow?.steps || []).map(step => [step.key, step]));
        const serverChat = completedServerChat(steps);
        if (!serverChat) {
            throw new RevenantMaterializationError(409, 'Server postprocess result is not ready');
        }
        const chat = { ...serverChat, message: serverChat.message.slice() };
        const mutationPatch = completedServerMutationPatch(steps);
        const messageIndex = chat.message.findIndex(message => message?.chatId === job.chatId);
        const materializedMessage = messageIndex >= 0 ? structuredClone(chat.message[messageIndex]) : undefined;
        if (materializedMessage && typeof materializedMessage.data !== 'string') {
            throw new RevenantMaterializationError(409, 'Server postprocess result is not ready');
        }
        if (materializedMessage) {
            chat.message[messageIndex] = materializedMessage;
            applyRevenantStageTimingToMessage(
                materializedMessage,
                workflow,
                job.completedAt || job.updatedAt,
            );
        }
        const memoryStep = steps.get('memory.hypav3');
        const hypaMemory = memoryStep?.status === 'completed' ? memoryStep.metadata?.hypaMemory : undefined;
        if (hypaMemory && typeof hypaMemory === 'object' && Array.isArray(hypaMemory.summaries)) {
            chat.hypaV3Data = structuredClone(hypaMemory);
        }
        chat.isStreaming = false;

        const responses = steps.get('message.materialize')?.metadata?.responses;
        updateGenerationWorkflowStep(workflow.workflowId, 'message.materialize', {
            status: 'running',
            metadata: {
                schemaVersion: 1, chat,
                ...(responses ? { responses } : {}),
            },
        });
        const commit = await commitGenerationResult({
            job,
            workflow,
            chat,
            mutationPatch,
            isAlreadyCommitted: () => !!getGenerationJob(jobId, false)?.materializedAt,
            finalize: () => {
                if (!markGenerationMaterialized(jobId)) {
                    throw new Error('Failed to mark generation materialized');
                }
            },
        });
        if (commit.alreadyCommitted) return { success: true, alreadyMaterialized: true };
        return { success: true, message: materializedMessage, chat: commit.chat };
    }

    /**
     * Cancellation owns the last durable journal projection just like normal
     * completion owns its postprocessed projection. Browsers only render it;
     * they never race to persist a partial response.
     */
    async function materializeCancelledJob(workflow, job) {
        const inputChat = getGenerationWorkflowInputChat(workflow.workflowId);
        const recipe = resolveRevenantPostprocessRecipe(workflow.context, inputChat);
        if (!inputChat?.id || !Array.isArray(inputChat.message) || !recipe?.chat) {
            throw new RevenantMaterializationError(409, 'Workflow has no durable cancellation input');
        }

        let projection = job.projection;
        const rawResponse = readGenerationJobRaw(job.jobId);
        if (
            rawResponse.length > 0
            && job.responseDecoder
            && !isGenerationProjectionCurrent(projection, rawResponse.length)
        ) {
            try {
                projection = await projectGenerationJournal(job, rawResponse);
                setGenerationJobProjection(job.jobId, projection);
            } catch (error) {
                setGenerationJobProjectionError(job.jobId, String(error));
                throw new RevenantMaterializationError(
                    409,
                    'Cancelled generation journal projection is not ready',
                );
            }
        }
        const partial = String(projection?.content || '');
        const chat = partial.trim()
            ? applyGeneratedMessage(recipe.chat, recipe, job, partial)
            : structuredClone(inputChat);
        chat.isStreaming = false;

        let commit;
        try {
            commit = await commitGenerationResult({
                job,
                workflow,
                chat,
                isAlreadyCommitted: () => !!getGenerationJob(job.jobId, false)?.materializedAt,
                finalize: () => {
                    if (!markGenerationMaterialized(job.jobId)) {
                        throw new Error('Failed to mark cancelled generation materialized');
                    }
                },
            });
        } catch (error) {
            if (!cancellationOwnsEveryConflict(job, error, recipe)) throw error;
            // A user edited or deleted the exact reroll target
            // while cancellation was settling. Their newer canonical choice
            // wins; acknowledge the partial so a later generation never drains
            // and resurrects it over that edit.
            if (!markGenerationMaterialized(job.jobId)) {
                throw new Error('Failed to discard superseded cancelled generation');
            }
            await canonicalChatService.publishCurrent(
                job.characterId,
                job.roomId,
                'generation-cancelled-discarded',
            );
            return { success: true, discarded: true };
        }
        if (commit.alreadyCommitted) return { success: true, alreadyMaterialized: true };
        return {
            success: true,
            chat: commit.chat,
            message: commit.chat.message.find(item => item?.chatId === job.chatId),
        };
    }

    async function materializeCancellation(workflowId) {
        const workflow = getGenerationWorkflow(workflowId);
        if (!workflow) {
            throw new RevenantMaterializationError(
                404,
                apiErrorMessage(codes.REVENANT_WORKFLOW_NOT_FOUND),
            );
        }
        if (workflow.status !== 'cancelled') {
            return { success: true, notCancelled: true };
        }
        const job = listGenerationWorkflowJobs(workflowId)
            .find(candidate => candidate.jobType === 'model'
                && candidate.characterId && candidate.roomId && candidate.chatId);
        if (!job) {
            await canonicalChatService.publishCurrent(
                workflow.characterId,
                workflow.roomId,
                'generation-cancelled',
            );
            return { success: true, noGenerationJob: true };
        }
        if (job.materializedAt) return { success: true, alreadyMaterialized: true };

        await drainEarlierCancelledGenerations(job);
        return materializeCancelledJob(workflow, job);
    }

    return { materialize, materializeCancellation };
}

module.exports = {
    createRevenantMaterializer,
    RevenantMaterializationError,
    applyMutationPatch,
};

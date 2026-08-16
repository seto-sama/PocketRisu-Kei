'use strict';

const { applyRevenantStageTimingToMessage } = require('./generationTiming.cjs');
const { applyGeneratedMessage } = require('./postprocessPipeline.cjs');
const { projectGenerationJournal } = require('./generationProjection.cjs');

class RevenantMaterializationError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'RevenantMaterializationError';
        this.status = status;
    }
}

function completedServerChat(workflow) {
    if (!workflow) return undefined;
    for (const key of ['message.materialize', 'postprocess', 'igp', 'trigger.output', 'output.transform']) {
        const step = workflow.steps?.find(item => item.key === key && item.status === 'completed');
        if (step?.metadata?.chat?.id && Array.isArray(step.metadata.chat.message)) {
            return structuredClone(step.metadata.chat);
        }
    }
    return undefined;
}

function mergeMutationPatch(target, source) {
    if (!source || typeof source !== 'object') return target;
    if (source.character && typeof source.character === 'object') {
        target.character = { ...(target.character || {}), ...structuredClone(source.character) };
    }
    if (source.database && typeof source.database === 'object') {
        target.database = { ...(target.database || {}), ...structuredClone(source.database) };
    }
    return target;
}

function completedServerMutationPatch(workflow) {
    const patch = {};
    for (const key of ['output.transform', 'trigger.output', 'igp', 'postprocess']) {
        const step = workflow?.steps?.find(item => item.key === key && item.status === 'completed');
        mergeMutationPatch(patch, step?.metadata?.mutations);
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
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
        listGenerationWorkflowJobs,
        listRecoverableGenerationJobs,
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
                throw new RevenantMaterializationError(error.httpStatus, error.message);
            }
            throw error;
        }
    }

    async function materialize(jobId) {
        const job = getGenerationJob(jobId, false);
        if (!job) throw new RevenantMaterializationError(404, 'Generation job not found');
        if (job.materializedAt) return { success: true, alreadyMaterialized: true };
        if (!job.characterId || !job.roomId || !job.chatId) {
            throw new RevenantMaterializationError(400, 'Generation job has no chat target');
        }
        if (['queued', 'generating'].includes(job.status)) {
            throw new RevenantMaterializationError(409, 'Generation job is not complete');
        }
        const earlierJob = listRecoverableGenerationJobs(200).find(candidate =>
            candidate.jobId !== job.jobId
            && candidate.characterId === job.characterId
            && candidate.roomId === job.roomId
            && candidate.createdAt < job.createdAt);
        if (earlierJob) {
            throw new RevenantMaterializationError(
                409,
                `Earlier generation must materialize first: ${earlierJob.jobId}`,
            );
        }

        const workflow = job.workflowId ? getGenerationWorkflow(job.workflowId) : undefined;
        const serverChat = completedServerChat(workflow);
        if (!serverChat) {
            throw new RevenantMaterializationError(409, 'Server postprocess result is not ready');
        }
        const chat = structuredClone(serverChat);
        const mutationPatch = completedServerMutationPatch(workflow);
        const materializedMessage = chat.message.find(message => message?.chatId === job.chatId);
        if (!materializedMessage || typeof materializedMessage.data !== 'string') {
            throw new RevenantMaterializationError(409, 'Server postprocess result is not ready');
        }
        applyRevenantStageTimingToMessage(
            materializedMessage,
            workflow,
            job.completedAt || job.updatedAt,
        );
        const hypaMemory = workflow?.steps
            ?.find(step => step.key === 'memory.hypav3' && step.status === 'completed')
            ?.metadata?.hypaMemory;
        if (hypaMemory && typeof hypaMemory === 'object' && Array.isArray(hypaMemory.summaries)) {
            chat.hypaV3Data = structuredClone(hypaMemory);
        }
        chat.isStreaming = false;

        updateGenerationWorkflowStep(workflow.workflowId, 'message.materialize', {
            status: 'running',
            metadata: { schemaVersion: 1, chat },
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
    async function materializeCancellation(workflowId) {
        const workflow = getGenerationWorkflow(workflowId);
        if (!workflow) throw new RevenantMaterializationError(404, 'Generation workflow not found');
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

        const inputChat = workflow.context?.inputCommit?.chat;
        const recipe = workflow.context?.postprocess;
        if (!inputChat?.id || !Array.isArray(inputChat.message) || !recipe?.chat) {
            throw new RevenantMaterializationError(409, 'Workflow has no durable cancellation input');
        }

        let projection = job.projection;
        if (!projection && job.rawBytes > 0) {
            try {
                projection = await projectGenerationJournal(job, readGenerationJobRaw(job.jobId));
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
        const projected = job.isContinuation
            && job.continuationPrefix
            && !partial.startsWith(job.continuationPrefix)
            ? job.continuationPrefix + partial
            : partial;
        const chat = projected.trim()
            ? applyGeneratedMessage(recipe.chat, recipe, job, projected)
            : structuredClone(inputChat);
        chat.isStreaming = false;

        const commit = await commitGenerationResult({
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
        if (commit.alreadyCommitted) return { success: true, alreadyMaterialized: true };
        return {
            success: true,
            chat: commit.chat,
            message: commit.chat.message.find(item => item?.chatId === job.chatId),
        };
    }

    return { materialize, materializeCancellation };
}

module.exports = {
    createRevenantMaterializer,
    RevenantMaterializationError,
    completedServerChat,
    completedServerMutationPatch,
    applyMutationPatch,
};

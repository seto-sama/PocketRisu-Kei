'use strict';

class RevenantMaterializationError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'RevenantMaterializationError';
        this.status = status;
    }
}

function completedServerChat(workflow) {
    if (!workflow) return undefined;
    for (const key of ['postprocess', 'igp', 'trigger.output', 'output.transform']) {
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
        listRecoverableGenerationJobs,
        markGenerationMaterialized,
    } = repository;
    const {
        queueStorageOperation,
        ensureChatStore,
        getChatStorageState,
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
        broadcastDatabaseInvalidated = () => {},
    } = options;

    async function materialize(jobId) {
        return queueStorageOperation(async () => {
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

            await ensureChatStore();
            const { fullChatStore, saveTimers, dbCache } = getChatStorageState();
            const storedChat = fullChatStore.get(job.characterId)?.get(job.roomId);
            if (!storedChat || !Array.isArray(storedChat.message)) {
                throw new RevenantMaterializationError(404, 'Target chat not found');
            }

            const workflow = job.workflowId ? getGenerationWorkflow(job.workflowId) : undefined;
            const serverChat = completedServerChat(workflow);
            if (!serverChat) {
                throw new RevenantMaterializationError(409, 'Server postprocess result is not ready');
            }
            const chat = structuredClone(serverChat);
            const mutationPatch = completedServerMutationPatch(workflow);
            let materializedMessage = chat.message.find(message => message?.chatId === job.chatId);
            if (!materializedMessage || typeof materializedMessage.data !== 'string') {
                throw new RevenantMaterializationError(409, 'Server postprocess result is not ready');
            }

            const hypaMemory = workflow?.steps
                ?.find(step => step.key === 'memory.hypav3' && step.status === 'completed')
                ?.metadata?.hypaMemory;
            if (hypaMemory && typeof hypaMemory === 'object' && Array.isArray(hypaMemory.summaries)) {
                chat.hypaV3Data = structuredClone(hypaMemory);
            }
            chat.isStreaming = false;

            if (!fullChatStore.has(job.characterId)) fullChatStore.set(job.characterId, new Map());
            fullChatStore.get(job.characterId).set(job.roomId, chat);
            if (saveTimers[databaseHexKey]) {
                clearTimeout(saveTimers[databaseHexKey]);
                delete saveTimers[databaseHexKey];
            }
            if (dbCache[databaseHexKey]) {
                applyMutationPatch(dbCache[databaseHexKey], job.characterId, mutationPatch);
                await persistDbCacheWithChats(databaseHexKey, 'database/database.bin');
            }
            else {
                const raw = kvGet('database/database.bin');
                if (!raw) throw new Error('Compatible database is missing');
                const dbObj = normalizeJSON(await decodeRisuSave(raw));
                const strippedDb = stripChatsFromDb(dbObj);
                applyMutationPatch(strippedDb, job.characterId, mutationPatch);
                const fullDb = reassembleFullDb(strippedDb);
                kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(fullDb)));
                initChatStore(fullDb);
            }
            createBackupAndRotate();
            if (!markGenerationMaterialized(jobId)) {
                throw new Error('Failed to mark generation materialized');
            }
            broadcastDatabaseInvalidated(undefined, {
                chats: [{ characterId: job.characterId, chatId: job.roomId }],
            });
            return { success: true, message: materializedMessage, chat };
        });
    }

    return { materialize };
}

module.exports = {
    createRevenantMaterializer,
    RevenantMaterializationError,
    completedServerChat,
    completedServerMutationPatch,
    applyMutationPatch,
};

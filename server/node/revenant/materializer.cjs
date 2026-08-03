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

function applyLegacyMessage(chat, job, incoming) {
    const snapshot = job.rerollSnapshot;
    let targetIndex = chat.message.findIndex(message => message?.chatId === job.chatId);
    if (targetIndex < 0 && snapshot) targetIndex = snapshot.targetIndex;
    if (targetIndex < 0 && job.isContinuation) {
        for (let index = chat.message.length - 1; index >= 0; index--) {
            if (chat.message[index]?.role === 'char') {
                targetIndex = index;
                break;
            }
        }
    }

    let materializedMessage;
    if (snapshot) {
        const current = chat.message[targetIndex];
        const alreadyCommitted = current?.chatId === job.chatId
            && Array.isArray(current.swipes)
            && current.swipes[current.swipeId] === incoming.data;
        if (alreadyCommitted) return current;
        const previousSwipes = Array.isArray(snapshot.targetMessage?.swipes)
            ? [...snapshot.targetMessage.swipes]
            : [snapshot.targetMessage?.data ?? ''];
        materializedMessage = {
            ...structuredClone(snapshot.targetMessage),
            ...structuredClone(incoming),
            role: 'char',
            data: incoming.data,
            chatId: job.chatId,
            swipes: [...previousSwipes, incoming.data],
            swipeId: previousSwipes.length,
        };
        chat.message.splice(
            Math.max(0, targetIndex),
            Math.max(0, chat.message.length - Math.max(0, targetIndex)),
            materializedMessage,
            ...structuredClone(snapshot.trailingMessages || []),
        );
    }
    else {
        materializedMessage = {
            ...(targetIndex >= 0 ? chat.message[targetIndex] : {}),
            ...structuredClone(incoming),
            role: incoming.role === 'user' ? 'user' : 'char',
            data: incoming.data,
            chatId: job.chatId,
        };
        if (targetIndex >= 0) chat.message[targetIndex] = materializedMessage;
        else chat.message.push(materializedMessage);
    }
    return materializedMessage;
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

    async function materialize(jobId, input = {}) {
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
            const submittedChat = input.chat?.id === job.roomId && Array.isArray(input.chat.message)
                ? input.chat
                : undefined;
            const chat = structuredClone(serverChat || submittedChat || storedChat);
            let materializedMessage = chat.message.find(message => message?.chatId === job.chatId);
            if (!serverChat) {
                if (!input.message || typeof input.message.data !== 'string') {
                    throw new RevenantMaterializationError(400, 'Processed generation message is required');
                }
                materializedMessage = applyLegacyMessage(chat, job, input.message);
            }
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
                await persistDbCacheWithChats(databaseHexKey, 'database/database.bin');
            }
            else {
                const raw = kvGet('database/database.bin');
                if (!raw) throw new Error('Compatible database is missing');
                const dbObj = normalizeJSON(await decodeRisuSave(raw));
                const fullDb = reassembleFullDb(stripChatsFromDb(dbObj));
                kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(fullDb)));
                initChatStore(fullDb);
            }
            createBackupAndRotate();
            if (!markGenerationMaterialized(jobId)) {
                throw new Error('Failed to mark generation materialized');
            }
            broadcastDatabaseInvalidated(input.request, {
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
};

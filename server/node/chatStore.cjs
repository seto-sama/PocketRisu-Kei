'use strict';

const crypto = require('crypto');
const API_ERROR_CODES = require('../../shared/apiErrorCodes.json');
const { encodeRisuSaveLegacy } = require('./utils/risuSave.cjs');
const { normalizeJSON } = require('./utils/json.cjs');
const { assertChatIdentity, chatToStub, optionalChatMetadataFields, runtimeOnlyChatFields } = require('../../shared/chatShape.mjs');
const { EntityIdValidationError } = require('../../shared/entityIds.mjs');
const { stripChatCompatibility } = require('./bookmarkStore.cjs');
const {
    ChatResultMergeConflict,
    mergeGenerationChatResult,
} = require('./revenant/chatResultMerge.cjs');
const { resolveRevenantPostprocessRecipe } = require('./revenant/generation.cjs');
const { applyDelta, DeltaConflictError, DeltaValidationError } = require('../../shared/guardedDelta.mjs');

const MISSING_CHAT_ETAG = 'missing';

function computeChatEtag(chat) {
    if (!chat) return MISSING_CHAT_ETAG;
    const encoded = Buffer.from(encodeRisuSaveLegacy(normalizeJSON(chat)));
    return crypto.createHash('sha256').update(encoded).digest('hex');
}

/**
 * The single compare-and-swap boundary for full chat bodies. Every writer—an
 * HTTP client or a server-side generation materializer—commits through here.
 */
function commitChatContent(store, characterId, chatId, incomingChat, expectedEtag, options = {}) {
    const characterChats = store.get(characterId);
    const currentChat = characterChats?.get(chatId);
    const currentEtag = computeChatEtag(currentChat);

    if ((options.requireExpected && currentChat && !expectedEtag)
        || (expectedEtag && expectedEtag !== currentEtag)) {
        return { success: false, conflict: true, currentEtag };
    }

    const committedChat = structuredClone(incomingChat);
    const nextCharacterChats = characterChats ?? new Map();
    if (!characterChats) store.set(characterId, nextCharacterChats);
    nextCharacterChats.set(chatId, committedChat);
    return {
        success: true,
        chat: committedChat,
        etag: computeChatEtag(committedChat),
    };
}

function mergeChatStubWithFullChat(stub, fullChat) {
    if (!fullChat) return stub;
    if (!stub || !stub._stub) return fullChat;
    const merged = {
        ...fullChat,
        id: stub.id || fullChat.id || '',
        name: stub.name,
    };
    if ('_stub' in merged) delete merged._stub;
    // Stub metadata is authoritative, including key absence. Keeping an old
    // value from the independently stored body when the stub omits a field
    // resurrects metadata that another client explicitly removed.
    for (const field of optionalChatMetadataFields) {
        if (field in stub) merged[field] = stub[field];
        else delete merged[field];
    }
    return merged;
}

function reassembleFullDb(strippedDb, store) {
    if (!strippedDb?.characters || !store) return strippedDb;
    const full = { ...strippedDb };
    full.characters = strippedDb.characters.map(char => {
        if (!char?.chaId || !char.chats) return char;
        const charChats = store.get(char.chaId);
        if (!charChats) return char;
        return {
            ...char,
            chats: char.chats.map(chat => {
                if (chat && chat._stub && chat.id) {
                    return mergeChatStubWithFullChat(chat, charChats.get(chat.id));
                }
                return chat;
            }),
        };
    });
    return full;
}

class CanonicalChatCommitError extends Error {
    constructor(status, message, options = {}) {
        super(message);
        this.name = 'CanonicalChatCommitError';
        this.httpStatus = status;
        this.currentEtag = options.currentEtag;
        this.conflicts = options.conflicts;
        this.code = options.code;
    }
}

/**
 * Own every canonical full-chat write after the payload store has been
 * initialized. Generation input, materialized output, and browser edits all
 * pass through the same queue, CAS, persistence, and publish boundary.
 */
function createCanonicalChatService(options) {
    const {
        queueStorageOperation,
        ensureChatStore,
        getChat,
        replaceChat,
        commitChatContent,
        computeChatEtag,
        getGenerationWorkflowInputChat,
        persistNow,
        schedulePersist,
        publishChatCommitted,
    } = options;

    function conflict(message, currentChat, options = {}) {
        return new CanonicalChatCommitError(409, message, {
            currentEtag: computeChatEtag(currentChat),
            code: API_ERROR_CODES.CHAT_CONTENT_CHANGED,
            ...options,
        });
    }

    async function commitCandidate({
        characterId,
        chatId,
        candidate,
        expectedEtag,
        persist,
        reason,
        originClientId,
        finalize,
    }) {
        try { assertChatIdentity(candidate, chatId); }
        catch (error) {
            if (error instanceof EntityIdValidationError) {
                throw new CanonicalChatCommitError(400, error.message);
            }
            throw error;
        }
        for (const field of runtimeOnlyChatFields) delete candidate[field];
        stripChatCompatibility(candidate);
        const previous = getChat(characterId, chatId);
        const result = commitChatContent(
            characterId,
            chatId,
            candidate,
            expectedEtag,
            { requireExpected: true },
        );
        if (!result.success) {
            throw conflict('Chat content changed on another client', previous);
        }
        let durableResult = result;
        try {
            const persisted = await persist(result.chat);
            // The durable relational store may reconcile independently-owned
            // list metadata (name/folder/modules) against the submitted body.
            // Adopt that exact canonical value and ETag before responding or
            // broadcasting so memory, SQL, and all connected clients agree.
            if (persisted?.chat) {
                const durableChat = structuredClone(persisted.chat);
                durableResult = {
                    ...result,
                    ...persisted,
                    success: true,
                    chat: durableChat,
                    etag: persisted.etag ?? computeChatEtag(durableChat),
                };
                replaceChat(characterId, chatId, durableChat);
            }
        } catch (error) {
            replaceChat(characterId, chatId, previous);
            throw error;
        }
        // Finalization lives in a separate durable store (the generation
        // journal). Once the canonical chat is persisted, never roll it back
        // merely because bookkeeping that can be retried failed afterward.
        await finalize?.(durableResult);
        publishChatCommitted({
            characterId,
            chatId,
            etag: durableResult.etag,
            reason,
        }, originClientId);
        return durableResult;
    }

    async function commitGenerationInput({ characterId, chatId, changes }) {
        return queueStorageOperation(async () => {
            await ensureChatStore(characterId, chatId);
            const input = applyChatDelta(characterId, chatId, changes);
            return commitCandidate({
                characterId,
                chatId,
                ...input,
                reason: 'generation-input',
                persist: chat => persistNow({
                    characterId,
                    chatId,
                    chat,
                    generationInput: true,
                }),
            });
        });
    }

    async function commitGenerationResult({
        job,
        workflow,
        chat,
        mutationPatch,
        isAlreadyCommitted,
        finalize,
    }) {
        return queueStorageOperation(async () => {
            if (isAlreadyCommitted?.()) {
                return { success: true, alreadyCommitted: true };
            }
            await ensureChatStore(job.characterId, job.roomId);
            const currentChat = getChat(job.characterId, job.roomId);
            if (!currentChat || !Array.isArray(currentChat.message)) {
                throw new CanonicalChatCommitError(404, 'Target chat not found');
            }
            const baseChat = workflow
                ? getGenerationWorkflowInputChat(workflow.workflowId)
                : undefined;
            if (!baseChat?.id || !Array.isArray(baseChat.message)) {
                throw new CanonicalChatCommitError(409, 'Workflow has no durable chat merge base');
            }
            let candidate;
            try {
                candidate = mergeGenerationChatResult(
                    baseChat,
                    chat,
                    currentChat,
                    resolveRevenantPostprocessRecipe(workflow.context, baseChat),
                );
            } catch (error) {
                throw new CanonicalChatCommitError(
                    409,
                    error instanceof Error ? error.message : String(error),
                    error instanceof ChatResultMergeConflict
                        ? { conflicts: error.paths }
                        : undefined,
                );
            }
            return commitCandidate({
                characterId: job.characterId,
                chatId: job.roomId,
                candidate,
                expectedEtag: computeChatEtag(currentChat),
                reason: 'generation-result',
                persist: committedChat => persistNow({
                    characterId: job.characterId,
                    chatId: job.roomId,
                    chat: committedChat,
                    mutationPatch,
                }),
                finalize,
            });
        });
    }

    function applyChatDelta(characterId, chatId, changes) {
        const current = getChat(characterId, chatId);
        let candidate;
        try {
            candidate = applyDelta(current ? normalizeJSON(current) : undefined, changes);
        } catch (error) {
            if (error instanceof DeltaConflictError) {
                throw conflict('Chat content changed on another client', current, {
                    conflicts: error.conflicts.map(item => item.change.path),
                });
            }
            if (error instanceof DeltaValidationError) {
                throw new CanonicalChatCommitError(400, error.message);
            }
            throw error;
        }
        return { candidate, expectedEtag: computeChatEtag(current) };
    }

    async function commitUserDelta({ characterId, chatId, changes, originClientId }) {
        return queueStorageOperation(async () => {
            await ensureChatStore(characterId, chatId);
            const { candidate, expectedEtag } = applyChatDelta(characterId, chatId, changes);
            return commitCandidate({
                characterId, chatId, candidate, expectedEtag,
                reason: 'user-edit', originClientId,
                persist: chat => schedulePersist({ characterId, chatId, chat }),
            });
        });
    }

    async function commitServerMutation({
        characterId,
        chatId,
        mutate,
        reason = 'server-mutation',
    }) {
        return queueStorageOperation(async () => {
            await ensureChatStore(characterId, chatId);
            const currentChat = getChat(characterId, chatId);
            if (!currentChat || !Array.isArray(currentChat.message)) {
                throw new CanonicalChatCommitError(404, 'Target chat not found');
            }
            const candidate = structuredClone(currentChat);
            const mutated = await mutate(candidate);
            return commitCandidate({
                characterId,
                chatId,
                candidate: mutated || candidate,
                expectedEtag: computeChatEtag(currentChat),
                reason,
                persist: committedChat => persistNow({
                    characterId,
                    chatId,
                    chat: committedChat,
                }),
            });
        });
    }

    async function publishCurrent(characterId, chatId, reason = 'canonical-handoff') {
        return queueStorageOperation(async () => {
            await ensureChatStore(characterId, chatId);
            const chat = getChat(characterId, chatId);
            if (!chat) return false;
            publishChatCommitted({
                characterId,
                chatId,
                etag: computeChatEtag(chat),
                reason,
            });
            return true;
        });
    }

    return {
        commitGenerationInput,
        commitGenerationResult,
        commitServerMutation,
        commitUserDelta,
        publishCurrent,
    };
}

module.exports = {
    MISSING_CHAT_ETAG,
    computeChatEtag,
    commitChatContent,
    chatToStub,
    mergeChatStubWithFullChat,
    reassembleFullDb,
    CanonicalChatCommitError,
    createCanonicalChatService,
};

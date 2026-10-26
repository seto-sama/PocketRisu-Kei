'use strict';

const crypto = require('crypto');
const API_ERROR_CODES = require('../shared/apiErrorCodes.json');
const { encodeRisuSaveLegacy } = require('./utils/risuSave.cjs');
const { normalizeJSON } = require('./utils/json.cjs');
const { assertChatIdentity, chatToStub, optionalChatMetadataFields, runtimeOnlyChatFields } = require('../shared/chatShape.mjs');
const { EntityIdValidationError } = require('../shared/entityIds.mjs');
const { stripChatCompatibility } = require('./bookmarkStore.cjs');
const {
    ChatResultMergeConflict,
    mergeGenerationChatResult,
} = require('./revenant/chatResultMerge.cjs');
const { resolveRevenantPostprocessRecipe } = require('./revenant/generation.cjs');
const { applyDelta, DeltaConflictError, DeltaValidationError } = require('../shared/guardedDelta.mjs');

const MISSING_CHAT_ETAG = 'missing';

function computeChatEtag(chat) {
    if (!chat) return MISSING_CHAT_ETAG;
    const encoded = Buffer.from(encodeRisuSaveLegacy(normalizeJSON(chat)));
    return crypto.createHash('sha256').update(encoded).digest('hex');
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

class CanonicalChatCommitError extends Error {
    constructor(status, message, options = {}) {
        super(message);
        this.name = 'CanonicalChatCommitError';
        this.httpStatus = status;
        this.currentEtag = options.currentEtag;
        this.conflicts = options.conflicts;
        this.action = options.action;
        this.cancelled = options.cancelled;
        this.code = options.code;
    }
}

/**
 * Own every canonical full-chat write after the relational store has been
 * initialized. Generation input, materialized output, and browser edits all
 * pass through the same queue, persistence CAS, and publish boundary.
 *
 * loadChat(characterId, chatId) returns a caller-owned { chat, etag } (or
 * undefined). persist callbacks receive the candidate and the ETag it was
 * derived from; the durable store rejects the write with an
 * AppDataConflictError when its row no longer carries that ETag.
 */
function createCanonicalChatService(options) {
    const {
        queueStorageOperation,
        loadChat,
        getGenerationWorkflowInputChat,
        persistChat,
        publishChatCommitted,
    } = options;

    function conflict(message, currentEtag, options = {}) {
        return new CanonicalChatCommitError(409, message, {
            currentEtag,
            code: API_ERROR_CODES.CHAT_CONTENT_CHANGED,
            ...options,
        });
    }

    async function loadExistingChat(characterId, chatId) {
        const current = await loadChat(characterId, chatId);
        if (!current || !Array.isArray(current.chat?.message)) {
            throw new CanonicalChatCommitError(404, 'Target chat not found');
        }
        return current;
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
        let persisted;
        try {
            persisted = await persist(candidate, expectedEtag);
        } catch (error) {
            if (error?.name === 'AppDataConflictError') {
                throw conflict('Chat content changed on another client', error.currentEtag);
            }
            throw error;
        }
        // The durable relational store may reconcile independently-owned
        // list metadata (name/folder/modules) against the submitted body.
        // Respond and broadcast its exact canonical value and ETag so SQL and
        // all connected clients agree.
        const result = { ...persisted, success: true };
        // Finalization lives in a separate durable store (the generation
        // journal). Once the canonical chat is persisted, never roll it back
        // merely because bookkeeping that can be retried failed afterward.
        await finalize?.(result);
        publishChatCommitted({
            characterId,
            chatId,
            etag: result.etag,
            reason,
        }, originClientId);
        return result;
    }

    async function commitGenerationInput({ characterId, chatId, changes }) {
        return queueStorageOperation(async () => {
            const input = await applyChatDelta(characterId, chatId, changes);
            return commitCandidate({
                characterId,
                chatId,
                ...input,
                reason: 'generation-input',
                persist: (chat, expectedEtag) => persistChat({
                    characterId,
                    chatId,
                    chat,
                    expectedEtag,
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
            const current = await loadExistingChat(job.characterId, job.roomId);
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
                    current.chat,
                    resolveRevenantPostprocessRecipe(workflow.context, baseChat),
                    workflow.steps?.find(step => step.key === 'message.materialize')?.metadata?.responses,
                );
            } catch (error) {
                throw new CanonicalChatCommitError(
                    409,
                    error instanceof Error ? error.message : String(error),
                    error instanceof ChatResultMergeConflict
                        ? { conflicts: error.paths, action: error.action, cancelled: error.cancelled }
                        : undefined,
                );
            }
            return commitCandidate({
                characterId: job.characterId,
                chatId: job.roomId,
                candidate,
                expectedEtag: current.etag,
                reason: 'generation-result',
                persist: (committedChat, expectedEtag) => persistChat({
                    characterId: job.characterId,
                    chatId: job.roomId,
                    chat: committedChat,
                    expectedEtag,
                    mutationPatch,
                }),
                finalize,
            });
        });
    }

    async function applyChatDelta(characterId, chatId, changes) {
        const current = await loadChat(characterId, chatId);
        const expectedEtag = current?.etag ?? MISSING_CHAT_ETAG;
        let candidate;
        try {
            candidate = applyDelta(current ? normalizeJSON(current.chat) : undefined, changes);
        } catch (error) {
            if (error instanceof DeltaConflictError) {
                throw conflict('Chat content changed on another client', expectedEtag, {
                    conflicts: error.conflicts.map(item => item.change.path),
                });
            }
            if (error instanceof DeltaValidationError) {
                throw new CanonicalChatCommitError(400, error.message);
            }
            throw error;
        }
        return { candidate, expectedEtag };
    }

    async function commitUserDelta({ characterId, chatId, changes, originClientId }) {
        return queueStorageOperation(async () => {
            const input = await applyChatDelta(characterId, chatId, changes);
            return commitCandidate({
                characterId, chatId, ...input,
                reason: 'user-edit', originClientId,
                persist: (chat, expectedEtag) => persistChat({ characterId, chatId, chat, expectedEtag }),
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
            const current = await loadExistingChat(characterId, chatId);
            const candidate = current.chat;
            const mutated = await mutate(candidate);
            return commitCandidate({
                characterId,
                chatId,
                candidate: mutated || candidate,
                expectedEtag: current.etag,
                reason,
                persist: (committedChat, expectedEtag) => persistChat({
                    characterId,
                    chatId,
                    chat: committedChat,
                    expectedEtag,
                }),
            });
        });
    }

    async function publishCurrent(characterId, chatId, reason = 'canonical-handoff') {
        return queueStorageOperation(async () => {
            const current = await loadChat(characterId, chatId);
            if (!current) return false;
            publishChatCommitted({
                characterId,
                chatId,
                etag: current.etag,
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
    chatToStub,
    mergeChatStubWithFullChat,
    CanonicalChatCommitError,
    createCanonicalChatService,
};

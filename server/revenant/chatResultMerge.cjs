'use strict';

const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const { applyDelta, createDelta, DeltaConflictError } = require('../../shared/guardedDelta.mjs');
const { resolveReplayAction } = require('./replayAction.cjs');

class ChatResultMergeConflict extends Error {
    constructor(paths, options = {}) {
        super(`Generation result overlaps concurrent chat edits: ${paths.join(', ')}`);
        this.name = 'ChatResultMergeConflict';
        this.paths = paths;
        this.action = options.action;
        this.cancelled = options.cancelled === true;
    }
}

function mergeScriptState(base, result, current, responses) {
    const changes = createDelta(base || {}, result || {});
    try {
        return applyDelta(current || {}, changes);
    } catch (error) {
        if (!(error instanceof DeltaConflictError)) throw error;
        const conflicts = error.conflicts.map(({ change, current }) => ({
            path: ['scriptstate', ...change.path],
            base: change.before.value,
            local: change.after.value,
            server: current.value,
        }));
        const paths = conflicts.map(({ path }) => '/' + path.map(part =>
            String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/'));
        // Bind choices to the exact values shown, so another edit requires a
        // new comparison rather than silently inheriting an older decision.
        const fingerprint = createHash('sha256').update(JSON.stringify(error.conflicts)).digest('hex');
        const action = resolveReplayAction(
            responses, `materialize.conflict:${fingerprint}`,
            'ui.resolve-conflict', { conflicts },
        );
        if (!action.available) throw new ChatResultMergeConflict(paths, { action: action.action });
        const choices = action.value;
        if (choices === null) throw new ChatResultMergeConflict(paths, { cancelled: true });
        if (!Array.isArray(choices) || choices.length !== conflicts.length
            || choices.some(choice => choice !== 'local' && choice !== 'server')) {
            throw new Error('Invalid generation conflict choices');
        }
        const resolutions = new Map(error.conflicts.map((conflict, index) => [conflict.change, {
            choice: choices[index], current: conflict.current,
        }]));
        return applyDelta(current || {}, changes.flatMap(change => {
            const resolution = resolutions.get(change);
            if (!resolution) return [change];
            return resolution.choice === 'server' ? [] : [{ ...change, before: resolution.current }];
        }));
    }
}

function messageIndexById(messages, chatId) {
    if (!chatId) return -1;
    return messages.findIndex(message => message?.chatId === chatId);
}

function insertByResultOrder(messages, resultMessages, resultIndex, message) {
    for (let index = resultIndex - 1; index >= 0; index--) {
        const anchor = messageIndexById(messages, resultMessages[index]?.chatId);
        if (anchor >= 0) {
            messages.splice(anchor + 1, 0, message);
            return;
        }
    }
    for (let index = resultIndex + 1; index < resultMessages.length; index++) {
        const anchor = messageIndexById(messages, resultMessages[index]?.chatId);
        if (anchor >= 0) {
            messages.splice(anchor, 0, message);
            return;
        }
    }
    messages.push(message);
}

function setResultField(target, source, key) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
        target[key] = source[key];
    } else {
        delete target[key];
    }
}

/**
 * Rebase the fields changed by one generation onto the latest canonical chat.
 * Unchanged messages remain entirely owned by concurrent editors. Only edits
 * to the same message/field conflict.
 */
function mergeGenerationChatResult(baseChat, resultChat, currentChat, operation, responses) {
    if (!baseChat?.id || baseChat.id !== resultChat?.id || baseChat.id !== currentChat?.id) {
        throw new ChatResultMergeConflict(['/id']);
    }
    const merged = { ...currentChat };
    const conflicts = [];

    const topLevelKeys = new Set([
        ...Object.keys(baseChat),
        ...Object.keys(resultChat),
    ]);
    topLevelKeys.delete('message');
    topLevelKeys.delete('isStreaming');
    for (const key of topLevelKeys) {
        const before = baseChat[key];
        const after = resultChat[key];
        if (isDeepStrictEqual(before, after)) continue;
        const current = currentChat[key];
        if (key === 'scriptstate' && [before, after, current].every(value =>
            value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value)))) {
            const state = mergeScriptState(before, after, current, responses);
            if (after === undefined && Object.keys(state).length === 0) delete merged[key];
            else merged[key] = state;
            continue;
        }
        if (isDeepStrictEqual(current, before) || isDeepStrictEqual(current, after)) {
            setResultField(merged, resultChat, key);
        } else {
            conflicts.push(`/${key}`);
        }
    }

    const baseMessages = baseChat.message;
    const resultMessages = resultChat.message;
    const currentMessages = currentChat.message;
    const mergedById = new Map(currentMessages.map(message => [message.chatId, message]));
    const baseById = new Map(baseMessages.map(message => [message.chatId, message]));
    const messageChatId = operation?.messageChatId;
    const ownedBaseId = operation?.rerollSnapshot?.targetMessage?.chatId;
    const ownedIds = new Set([
        messageChatId,
        ownedBaseId,
        ...(operation?.rerollSnapshot?.trailingMessages || [])
            .map(message => message?.chatId),
    ].filter(Boolean));
    const resultById = new Map(resultMessages
        .filter(message => message?.chatId)
        .map(message => [message.chatId, message]));
    const generated = resultById.get(messageChatId);

    for (const before of baseMessages) {
        if (!before?.chatId || (generated && ownedIds.has(before.chatId))) continue;
        const after = resultById.get(before.chatId);
        if (isDeepStrictEqual(before, after)) continue;
        const current = mergedById.get(before.chatId);
        if (!after) {
            if (!current || isDeepStrictEqual(current, before)) {
                mergedById.delete(before.chatId);
            } else {
                conflicts.push(`/message/${before.chatId}`);
            }
        } else if (isDeepStrictEqual(current, before)) {
            mergedById.set(before.chatId, after);
        } else if (!isDeepStrictEqual(current, after)) {
            conflicts.push(`/message/${before.chatId}`);
        }
    }

    const mergedMessages = [];
    for (const message of currentMessages) {
        const retained = mergedById.get(message.chatId);
        if (retained) mergedMessages.push(retained);
    }
    for (let resultIndex = 0; resultIndex < resultMessages.length; resultIndex++) {
        const added = resultMessages[resultIndex];
        if (!added?.chatId || baseById.has(added.chatId) || ownedIds.has(added.chatId)) continue;
        const current = mergedById.get(added.chatId);
        if (!current) {
            insertByResultOrder(mergedMessages, resultMessages, resultIndex, added);
            mergedById.set(added.chatId, added);
        } else if (!isDeepStrictEqual(current, added)) {
            conflicts.push(`/message/${added.chatId}`);
        }
    }

    if (generated) {
        let targetIndex = messageIndexById(mergedMessages, messageChatId);
        if (targetIndex < 0 && ownedBaseId) {
            targetIndex = messageIndexById(mergedMessages, ownedBaseId);
        }
        if (
            targetIndex < 0
            && operation?.rerollSnapshot
            && Number.isInteger(operation.rerollSnapshot.targetIndex)
            && operation.rerollSnapshot.targetIndex < mergedMessages.length
        ) {
            targetIndex = operation.rerollSnapshot.targetIndex;
        }
        const baseTarget = baseById.get(ownedBaseId);
        const currentTarget = targetIndex >= 0 ? mergedMessages[targetIndex] : undefined;
        if (baseTarget && currentTarget && (
            (currentTarget.chatId === ownedBaseId && !isDeepStrictEqual(currentTarget, baseTarget))
            || ![ownedBaseId, messageChatId].includes(currentTarget.chatId)
        )) {
            conflicts.push(`/message/${ownedBaseId}`);
        } else if (targetIndex >= 0) {
            mergedMessages[targetIndex] = generated;
        } else {
            insertByResultOrder(
                mergedMessages,
                resultMessages,
                resultMessages.indexOf(generated),
                generated,
            );
        }
    }

    if (conflicts.length > 0) throw new ChatResultMergeConflict([...new Set(conflicts)]);
    merged.message = mergedMessages;
    merged.isStreaming = false;
    return structuredClone(merged);
}

module.exports = {
    ChatResultMergeConflict,
    mergeGenerationChatResult,
};

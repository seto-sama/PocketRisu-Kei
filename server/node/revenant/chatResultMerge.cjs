'use strict';

const { isDeepStrictEqual } = require('node:util');

class ChatResultMergeConflict extends Error {
    constructor(paths) {
        super(`Generation result overlaps concurrent chat edits: ${paths.join(', ')}`);
        this.name = 'ChatResultMergeConflict';
        this.paths = paths;
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
            messages.splice(anchor + 1, 0, structuredClone(message));
            return;
        }
    }
    for (let index = resultIndex + 1; index < resultMessages.length; index++) {
        const anchor = messageIndexById(messages, resultMessages[index]?.chatId);
        if (anchor >= 0) {
            messages.splice(anchor, 0, structuredClone(message));
            return;
        }
    }
    messages.push(structuredClone(message));
}

function setResultField(target, source, key) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
        target[key] = structuredClone(source[key]);
    } else {
        delete target[key];
    }
}

/**
 * Rebase the fields changed by one generation onto the latest canonical chat.
 * Unchanged messages remain entirely owned by concurrent editors. Only edits
 * to the same message/field conflict.
 */
function mergeChatChanges(baseChat, resultChat, currentChat, operation, applyOwnedTarget) {
    if (!baseChat?.id || baseChat.id !== resultChat?.id || baseChat.id !== currentChat?.id) {
        throw new ChatResultMergeConflict(['/id']);
    }
    const merged = structuredClone(currentChat);
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
        if (isDeepStrictEqual(current, before) || isDeepStrictEqual(current, after)) {
            setResultField(merged, resultChat, key);
        } else {
            conflicts.push(`/${key}`);
        }
    }

    const baseMessages = Array.isArray(baseChat.message) ? baseChat.message : [];
    const resultMessages = Array.isArray(resultChat.message) ? resultChat.message : [];
    const mergedMessages = Array.isArray(merged.message) ? merged.message : [];
    const messageChatId = operation?.messageChatId;
    const rerollBaseId = operation?.rerollSnapshot?.targetMessage?.chatId;
    const continuationBase = operation?.isContinuation
        ? [...baseMessages].reverse().find(message => message?.role === 'char')
        : undefined;
    const ownedBaseId = rerollBaseId || continuationBase?.chatId;
    const ownedIds = new Set([
        messageChatId,
        ownedBaseId,
        ...(operation?.rerollSnapshot?.trailingMessages || [])
            .map(message => message?.chatId),
    ].filter(Boolean));
    const resultById = new Map(resultMessages
        .filter(message => message?.chatId)
        .map(message => [message.chatId, message]));

    for (const before of baseMessages) {
        if (!before?.chatId || ownedIds.has(before.chatId)) continue;
        const after = resultById.get(before.chatId);
        if (isDeepStrictEqual(before, after)) continue;
        const currentIndex = messageIndexById(mergedMessages, before.chatId);
        const current = currentIndex >= 0 ? mergedMessages[currentIndex] : undefined;
        if (!after) {
            if (!current || isDeepStrictEqual(current, before)) {
                if (currentIndex >= 0) mergedMessages.splice(currentIndex, 1);
            } else {
                conflicts.push(`/message/${before.chatId}`);
            }
        } else if (isDeepStrictEqual(current, before)) {
            mergedMessages[currentIndex] = structuredClone(after);
        } else if (!isDeepStrictEqual(current, after)) {
            conflicts.push(`/message/${before.chatId}`);
        }
    }

    const baseIds = new Set(baseMessages.map(message => message?.chatId).filter(Boolean));
    for (let resultIndex = 0; resultIndex < resultMessages.length; resultIndex++) {
        const added = resultMessages[resultIndex];
        if (!added?.chatId || baseIds.has(added.chatId) || ownedIds.has(added.chatId)) continue;
        const currentIndex = messageIndexById(mergedMessages, added.chatId);
        if (currentIndex < 0) {
            insertByResultOrder(mergedMessages, resultMessages, resultIndex, added);
        } else if (!isDeepStrictEqual(mergedMessages[currentIndex], added)) {
            conflicts.push(`/message/${added.chatId}`);
        }
    }

    const generated = resultMessages.find(message => message?.chatId === messageChatId);
    if (applyOwnedTarget && generated) {
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
        const baseTarget = ownedBaseId
            ? baseMessages.find(message => message?.chatId === ownedBaseId)
            : undefined;
        const currentTarget = targetIndex >= 0 ? mergedMessages[targetIndex] : undefined;
        if (baseTarget && currentTarget && (
            (currentTarget.chatId === ownedBaseId && !isDeepStrictEqual(currentTarget, baseTarget))
            || ![ownedBaseId, messageChatId].includes(currentTarget.chatId)
        )) {
            conflicts.push(`/message/${ownedBaseId}`);
        } else if (targetIndex >= 0) {
            mergedMessages[targetIndex] = structuredClone(generated);
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
    if (applyOwnedTarget) merged.isStreaming = false;
    return merged;
}

function mergeGenerationChatResult(baseChat, resultChat, currentChat, operation) {
    return mergeChatChanges(baseChat, resultChat, currentChat, operation, true);
}

/**
 * Detect a whole-chat save made from the pre-generation reroll/continuation
 * view after the server has already installed the generated replacement.
 * A normal post-generation edit keeps the generated message id; this shape
 * specifically resurrects the durable input target.
 */
function isStaleGenerationTargetWrite(incomingChat, currentChat, operation) {
    const generatedId = operation?.messageChatId;
    if (!generatedId || !Array.isArray(incomingChat?.message) || !Array.isArray(currentChat?.message)) {
        return false;
    }
    if (messageIndexById(currentChat.message, generatedId) < 0) return false;
    if (messageIndexById(incomingChat.message, generatedId) >= 0) return false;

    const rerollBaseId = operation?.rerollSnapshot?.targetMessage?.chatId;
    if (rerollBaseId && messageIndexById(incomingChat.message, rerollBaseId) >= 0) return true;

    if (operation?.isContinuation) {
        const baseMessages = operation?.chat?.message || [];
        const continuationBase = [...baseMessages].reverse().find(message => message?.role === 'char');
        return !!continuationBase?.chatId
            && messageIndexById(incomingChat.message, continuationBase.chatId) >= 0;
    }
    return false;
}

/** Rebase only client-owned edits while leaving the live generation target alone. */
function mergeConcurrentChatEdit(baseChat, editedChat, currentChat, operation) {
    return mergeChatChanges(baseChat, editedChat, currentChat, operation, false);
}

module.exports = {
    ChatResultMergeConflict,
    mergeConcurrentChatEdit,
    mergeGenerationChatResult,
    isStaleGenerationTargetWrite,
};

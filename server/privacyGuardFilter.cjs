const { DeltaConflictError, valuesEqual } = require('../shared/guardedDelta.mjs');

// These helpers never mutate their inputs: changed levels are rebuilt and the rest is shared,
// since every caller works on a freshly exported projection.

// Folders flagged `localOnly` are the ones privacy guard hides (the key predates the guard).
function isLocalOnlyFolder(folder) {
    return folder?.localOnly === true;
}

function collectHiddenCharacterIds(dbObj) {
    const hidden = new Set();
    for (const entry of dbObj?.characterOrder ?? []) {
        if (entry && typeof entry !== 'string' && isLocalOnlyFolder(entry)) {
            for (const chaId of entry.data ?? []) {
                if (typeof chaId === 'string') hidden.add(chaId);
            }
        }
    }
    // A trashed character has left its folder; trashFolder remembers whether it was local-only.
    for (const char of dbObj?.characters ?? []) {
        if (typeof char?.chaId === 'string' && isLocalOnlyFolder(char.trashFolder)) hidden.add(char.chaId);
    }
    return hidden;
}

function hiddenChatFolderIdsOf(char) {
    return new Set(
        (char?.chatFolders ?? [])
            .filter(isLocalOnlyFolder)
            .map(folder => folder?.id)
            .filter(Boolean)
    );
}

function visibleCharacter(char) {
    const hiddenChatFolderIds = hiddenChatFolderIdsOf(char);
    if (hiddenChatFolderIds.size === 0) return char;
    return {
        ...char,
        chatFolders: (char.chatFolders ?? []).filter(folder => !isLocalOnlyFolder(folder)),
        chats: (char.chats ?? []).filter(chat => !chat?.folderId || !hiddenChatFolderIds.has(chat.folderId)),
    };
}

function filterHiddenFolders(dbObj) {
    const filtered = { ...dbObj };
    const hiddenCharacterIds = collectHiddenCharacterIds(filtered);
    if (Array.isArray(filtered.characterOrder)) {
        filtered.characterOrder = filtered.characterOrder
            .map(entry => {
                if (typeof entry === 'string') {
                    return hiddenCharacterIds.has(entry) ? null : entry;
                }
                if (!entry || typeof entry !== 'object') return entry;
                if (isLocalOnlyFolder(entry)) return null;
                return {
                    ...entry,
                    data: (entry.data ?? []).filter(chaId => !hiddenCharacterIds.has(chaId)),
                };
            })
            .filter(Boolean);
    }

    if (Array.isArray(filtered.characters)) {
        filtered.characters = filtered.characters
            .filter(char => char?.chaId && !hiddenCharacterIds.has(char.chaId))
            .map(visibleCharacter);
    }

    return filtered;
}

function insertHiddenEntries(original = [], visible = [], isHidden, idOf) {
    const merged = [...visible];
    const present = new Set(visible.map(idOf).filter(Boolean));
    original.forEach((entry, index) => {
        if (!isHidden(entry) || present.has(idOf(entry))) return;
        merged.splice(Math.min(index, merged.length), 0, entry);
        present.add(idOf(entry));
    });
    return merged;
}

function mergeById(original = [], visible = [], idOf, isHidden, combine = (_stored, item) => item) {
    const visibleById = new Map(visible.filter(idOf).map(item => [idOf(item), item]));
    const used = new Set();
    const merged = [];
    for (const stored of original) {
        if (isHidden(stored)) {
            merged.push(stored);
            continue;
        }
        const item = idOf(stored) && visibleById.get(idOf(stored));
        if (item) {
            merged.push(combine(stored, item));
            used.add(item);
        }
    }
    for (const item of visible) {
        if (!used.has(item)) merged.push(item);
    }
    return merged;
}

function mergeVisibleCharacter(originalChar, visibleChar) {
    const hiddenChatFolderIds = hiddenChatFolderIdsOf(originalChar);
    if (hiddenChatFolderIds.size === 0) return visibleChar;
    return {
        ...visibleChar,
        chatFolders: insertHiddenEntries(originalChar.chatFolders, visibleChar.chatFolders, isLocalOnlyFolder, folder => folder?.id),
        chats: mergeById(originalChar.chats, visibleChar.chats, chat => chat?.id,
            chat => !!chat?.folderId && hiddenChatFolderIds.has(chat.folderId)),
    };
}

// The full-database import replaces everything, so hidden entries the guarded client never had come back from the original.
function mergeHiddenFolders(original, visible) {
    if (!original?.characters || !visible?.characters) return visible;
    const hiddenCharacterIds = collectHiddenCharacterIds(original);
    return {
        ...visible,
        characters: mergeById(original.characters, visible.characters, char => char?.chaId,
            char => hiddenCharacterIds.has(char?.chaId), mergeVisibleCharacter),
        characterOrder: insertHiddenEntries(original.characterOrder, visible.characterOrder,
            entry => (typeof entry === 'string' ? hiddenCharacterIds.has(entry) : isLocalOnlyFolder(entry)),
            entry => (typeof entry === 'string' ? entry : entry?.id)),
    };
}

function collectHiddenIds(dbObj) {
    const hiddenIds = collectHiddenCharacterIds(dbObj);
    for (const entry of dbObj?.characterOrder ?? []) {
        if (isLocalOnlyFolder(entry) && typeof entry.id === 'string') hiddenIds.add(entry.id);
    }
    for (const char of dbObj?.characters ?? []) {
        const hideAll = hiddenIds.has(char?.chaId);
        const hiddenChatFolderIds = hiddenChatFolderIdsOf(char);
        for (const id of hiddenChatFolderIds) hiddenIds.add(id);
        for (const chat of char?.chats ?? []) {
            if (chat?.id && (hideAll || hiddenChatFolderIds.has(chat.folderId))) hiddenIds.add(chat.id);
        }
    }
    return hiddenIds;
}

// A delta is ID-addressed, so applying it to the unfiltered projection already leaves hidden
// entries in place. A guarded client never saw a hidden ID, so a change naming one is a missing
// target to it; and it deleted a character it saw filtered, which would never match the stored one.
function guardHiddenDelta(dbObj, changes) {
    const hiddenIds = collectHiddenIds(dbObj);
    const charactersById = new Map((dbObj?.characters ?? []).map(char => [char?.chaId, char]));
    const conflicts = [];
    const guarded = changes.map(change => {
        const path = Array.isArray(change?.path) ? change.path : [];
        const named = [
            ...path.map(part => part?.value),
            ...(change?.kind === 'order' && Array.isArray(change.before) ? change.before : []),
            ...(change?.kind === 'order' && Array.isArray(change.after) ? change.after : []),
        ];
        if (named.some(id => hiddenIds.has(id))) {
            conflicts.push({ change, current: { exists: false } });
            return change;
        }
        const stored = path.length === 2 && path[0] === 'characters'
            && change.before?.exists && !change.after?.exists
            && charactersById.get(path[1]?.value);
        if (stored && valuesEqual(change.before.value, visibleCharacter(stored))) {
            return { ...change, before: { exists: true, value: stored } };
        }
        return change;
    });
    if (conflicts.length > 0) throw new DeltaConflictError(conflicts);
    return guarded;
}

function isChatHidden(dbObj, chaId, chatIndex, chatId) {
    const hiddenIds = collectHiddenIds(dbObj);
    if (hiddenIds.has(chaId)) return true;
    const chats = dbObj?.characters?.find(char => char?.chaId === chaId)?.chats ?? [];
    return hiddenIds.has(chatId || chats[chatIndex]?.id);
}

// An orphan's character or chat is gone, so nothing shows it was not hidden; privacy guard
// hides it rather than guess. Orphans are defined as in the inlay gallery's filters.
function createHiddenInlayFilter(dbObj) {
    const hiddenIds = collectHiddenIds(dbObj);
    const chatIdsByCharacter = new Map((dbObj?.characters ?? [])
        .map(char => [char?.chaId, new Set((char?.chats ?? []).map(chat => chat?.id))]));
    const allChatIds = new Set([...chatIdsByCharacter.values()].flatMap(ids => [...ids]));
    return meta => {
        const charId = meta?.charId;
        const chatId = meta?.chatId;
        if (hiddenIds.has(charId) || hiddenIds.has(chatId)) return true;
        if (charId && !chatIdsByCharacter.has(charId)) return true;
        return !!chatId && !(charId ? chatIdsByCharacter.get(charId) : allChatIds).has(chatId);
    };
}

module.exports = {
    createHiddenInlayFilter,
    filterHiddenFolders,
    guardHiddenDelta,
    isChatHidden,
    mergeHiddenFolders,
};

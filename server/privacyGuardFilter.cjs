function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

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

function filterHiddenFolders(dbObj) {
    const filtered = cloneJson(dbObj);
    if (!filtered || typeof filtered !== 'object') return filtered;

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
            .map(char => {
                const hiddenChatFolderIds = hiddenChatFolderIdsOf(char);
                if (hiddenChatFolderIds.size === 0) return char;

                const nextChats = (char.chats ?? [])
                    .filter(chat => !chat?.folderId || !hiddenChatFolderIds.has(chat.folderId));
                return {
                    ...char,
                    chatFolders: (char.chatFolders ?? []).filter(folder => !isLocalOnlyFolder(folder)),
                    chats: nextChats,
                };
            });
    }

    return filtered;
}

function mergeRemoteCharacterOrder(originalOrder = [], remoteOrder = [], hiddenCharacterIds = new Set()) {
    const merged = cloneJson(remoteOrder) ?? [];
    const hasEntry = (entry) => {
        if (typeof entry === 'string') return merged.includes(entry);
        if (!entry?.id) return false;
        return merged.some(item => item && typeof item !== 'string' && item.id === entry.id);
    };

    originalOrder.forEach((entry, index) => {
        const shouldPreserve = typeof entry === 'string'
            ? hiddenCharacterIds.has(entry)
            : entry && typeof entry === 'object' && isLocalOnlyFolder(entry);
        if (!shouldPreserve || hasEntry(entry)) return;
        merged.splice(Math.min(index, merged.length), 0, cloneJson(entry));
    });

    return merged;
}

function mergeRemoteChatFolders(originalFolders = [], remoteFolders = []) {
    const merged = [...(remoteFolders ?? [])];
    const hasFolder = (folder) => folder?.id && merged.some(item => item?.id === folder.id);
    originalFolders.forEach((folder, index) => {
        if (!isLocalOnlyFolder(folder) || hasFolder(folder)) return;
        merged.splice(Math.min(index, merged.length), 0, folder);
    });
    return merged;
}

function mergeRemoteChats(originalChats = [], remoteChats = [], hiddenChatFolderIds = new Set()) {
    const remoteById = new Map();
    const usedRemote = new Set();
    for (const chat of remoteChats ?? []) {
        if (chat?.id) remoteById.set(chat.id, chat);
    }

    const merged = [];
    for (const originalChat of originalChats ?? []) {
        if (originalChat?.folderId && hiddenChatFolderIds.has(originalChat.folderId)) {
            merged.push(originalChat);
            continue;
        }
        if (originalChat?.id && remoteById.has(originalChat.id)) {
            const remoteChat = remoteById.get(originalChat.id);
            merged.push(remoteChat);
            usedRemote.add(remoteChat);
        }
    }
    for (const remoteChat of remoteChats ?? []) {
        if (!usedRemote.has(remoteChat)) merged.push(remoteChat);
    }

    return merged;
}

function mergeRemoteCharacter(originalChar, remoteChar) {
    const hiddenChatFolderIds = hiddenChatFolderIdsOf(originalChar);
    if (hiddenChatFolderIds.size === 0) return remoteChar;

    remoteChar.chatFolders = mergeRemoteChatFolders(originalChar.chatFolders, remoteChar.chatFolders);
    remoteChar.chats = mergeRemoteChats(
        originalChar.chats ?? [],
        remoteChar.chats ?? [],
        hiddenChatFolderIds
    );
    return remoteChar;
}

function mergeHiddenFolders(originalDb, remoteDb) {
    const original = cloneJson(originalDb);
    const remote = cloneJson(remoteDb);
    if (!original?.characters || !remote?.characters) return remote;

    const hiddenCharacterIds = collectHiddenCharacterIds(original);
    const remoteById = new Map();
    const usedRemote = new Set();
    for (const char of remote.characters ?? []) {
        if (char?.chaId) remoteById.set(char.chaId, char);
    }

    const mergedCharacters = [];
    for (const originalChar of original.characters ?? []) {
        const chaId = originalChar?.chaId;
        if (!chaId) continue;
        if (hiddenCharacterIds.has(chaId)) {
            mergedCharacters.push(originalChar);
            continue;
        }
        const remoteChar = remoteById.get(chaId);
        if (remoteChar) {
            mergedCharacters.push(mergeRemoteCharacter(originalChar, remoteChar));
            usedRemote.add(remoteChar);
        }
    }
    for (const remoteChar of remote.characters ?? []) {
        if (!usedRemote.has(remoteChar)) mergedCharacters.push(remoteChar);
    }

    remote.characters = mergedCharacters;
    remote.characterOrder = mergeRemoteCharacterOrder(
        original.characterOrder ?? [],
        remote.characterOrder ?? [],
        hiddenCharacterIds
    );
    return remote;
}

function isChatHidden(dbObj, chaId, chatIndex, chatId) {
    if (collectHiddenCharacterIds(dbObj).has(chaId)) return true;
    const char = dbObj?.characters?.find(c => c?.chaId === chaId);
    if (!char) return false;
    const hiddenChatFolderIds = hiddenChatFolderIdsOf(char);
    if (hiddenChatFolderIds.size === 0) return false;
    const chat = chatId
        ? (char.chats ?? []).find(c => c?.id === chatId)
        : char.chats?.[chatIndex];
    return !!(chat?.folderId && hiddenChatFolderIds.has(chat.folderId));
}

/** Predicate over inlay metadata: true when the inlay belongs to a hidden character or chat. */
function createHiddenInlayFilter(dbObj) {
    const hiddenCharacterIds = collectHiddenCharacterIds(dbObj);
    const hiddenChatIds = new Set();
    for (const char of dbObj?.characters ?? []) {
        const hideAll = hiddenCharacterIds.has(char?.chaId);
        const hiddenChatFolderIds = hideAll ? null : hiddenChatFolderIdsOf(char);
        for (const chat of char?.chats ?? []) {
            if (!chat?.id) continue;
            if (hideAll || (chat.folderId && hiddenChatFolderIds.has(chat.folderId))) hiddenChatIds.add(chat.id);
        }
    }
    return meta => hiddenCharacterIds.has(meta?.charId) || hiddenChatIds.has(meta?.chatId);
}

module.exports = {
    createHiddenInlayFilter,
    filterHiddenFolders,
    isChatHidden,
    mergeHiddenFolders,
};

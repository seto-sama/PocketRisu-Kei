function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function hostWithoutPort(rawHost) {
    const host = String(rawHost).split(',')[0].trim().toLowerCase();
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        return end === -1 ? host : host.slice(1, end);
    }
    return host.split(':')[0];
}

function requestHostCandidates(req) {
    const rawHosts = [];
    const forwardedHost = req.headers['x-forwarded-host'];
    if (Array.isArray(forwardedHost)) {
        rawHosts.push(...forwardedHost);
    } else if (forwardedHost) {
        rawHosts.push(...String(forwardedHost).split(','));
    }
    if (req.headers.host) rawHosts.push(req.headers.host);
    return rawHosts
        .map(hostWithoutPort)
        .filter(Boolean);
}

function isCloudflareTunnelRequest(req, tunnelUrl) {
    const hosts = requestHostCandidates(req);
    if (hosts.some(host => host.endsWith('.trycloudflare.com'))) return true;
    if (!tunnelUrl) return false;
    try {
        const tunnelHost = new URL(tunnelUrl).hostname.toLowerCase();
        return hosts.some(host => host === tunnelHost);
    } catch {
        return false;
    }
}

function isLocalOnlyFolder(folder) {
    return folder?.localOnly === true;
}

function collectRemoteHiddenCharacterIds(dbObj) {
    const hidden = new Set();
    for (const entry of dbObj?.characterOrder ?? []) {
        if (entry && typeof entry !== 'string' && isLocalOnlyFolder(entry)) {
            for (const chaId of entry.data ?? []) {
                if (typeof chaId === 'string') hidden.add(chaId);
            }
        }
    }
    return hidden;
}

function filterRemoteOnlyFolders(dbObj) {
    const filtered = cloneJson(dbObj);
    if (!filtered || typeof filtered !== 'object') return filtered;

    const hiddenCharacterIds = collectRemoteHiddenCharacterIds(filtered);
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
                const hiddenChatFolderIds = new Set(
                    (char.chatFolders ?? [])
                        .filter(isLocalOnlyFolder)
                        .map(folder => folder?.id)
                        .filter(Boolean)
                );
                if (hiddenChatFolderIds.size === 0) return char;

                const currentChat = Array.isArray(char.chats) ? char.chats[char.chatPage] : null;
                const nextChats = (char.chats ?? [])
                    .filter(chat => !chat?.folderId || !hiddenChatFolderIds.has(chat.folderId));
                const nextChar = {
                    ...char,
                    chatFolders: (char.chatFolders ?? []).filter(folder => !isLocalOnlyFolder(folder)),
                    chats: nextChats,
                    chatPage: 0,
                };
                if (currentChat && nextChats.length > 0) {
                    const currentId = currentChat.id;
                    const nextIndex = currentId
                        ? nextChats.findIndex(chat => chat?.id === currentId)
                        : nextChats.indexOf(currentChat);
                    nextChar.chatPage = nextIndex >= 0 ? nextIndex : 0;
                }
                return nextChar;
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
    const merged = cloneJson(remoteFolders) ?? [];
    const hasFolder = (folder) => folder?.id && merged.some(item => item?.id === folder.id);
    originalFolders.forEach((folder, index) => {
        if (!isLocalOnlyFolder(folder) || hasFolder(folder)) return;
        merged.splice(Math.min(index, merged.length), 0, cloneJson(folder));
    });
    return merged;
}

function mergeRemoteChats(originalChats = [], remoteChats = [], hiddenChatFolderIds = new Set(), remoteChatPage = 0) {
    const remoteById = new Map();
    const usedRemote = new Set();
    for (const chat of remoteChats ?? []) {
        if (chat?.id) remoteById.set(chat.id, chat);
    }

    const merged = [];
    for (const originalChat of originalChats ?? []) {
        if (originalChat?.folderId && hiddenChatFolderIds.has(originalChat.folderId)) {
            merged.push(cloneJson(originalChat));
            continue;
        }
        if (originalChat?.id && remoteById.has(originalChat.id)) {
            const remoteChat = remoteById.get(originalChat.id);
            merged.push(cloneJson(remoteChat));
            usedRemote.add(remoteChat);
        }
    }
    for (const remoteChat of remoteChats ?? []) {
        if (!usedRemote.has(remoteChat)) merged.push(cloneJson(remoteChat));
    }

    const selectedRemote = remoteChats?.[remoteChatPage];
    const chatPage = selectedRemote?.id
        ? Math.max(0, merged.findIndex(chat => chat?.id === selectedRemote.id))
        : 0;
    return {
        chats: merged,
        chatPage: chatPage >= 0 ? chatPage : 0,
    };
}

function mergeRemoteCharacter(originalChar, remoteChar) {
    if (!originalChar) return cloneJson(remoteChar);
    if (!remoteChar) return cloneJson(originalChar);

    const hiddenChatFolderIds = new Set(
        (originalChar.chatFolders ?? [])
            .filter(isLocalOnlyFolder)
            .map(folder => folder?.id)
            .filter(Boolean)
    );
    if (hiddenChatFolderIds.size === 0) return cloneJson(remoteChar);

    const merged = cloneJson(remoteChar);
    merged.chatFolders = mergeRemoteChatFolders(originalChar.chatFolders, remoteChar.chatFolders);
    const chatMerge = mergeRemoteChats(
        originalChar.chats ?? [],
        remoteChar.chats ?? [],
        hiddenChatFolderIds,
        remoteChar.chatPage ?? 0
    );
    merged.chats = chatMerge.chats;
    merged.chatPage = chatMerge.chatPage;
    return merged;
}

function mergeRemoteFilteredDatabase(originalDb, remoteDb) {
    const original = cloneJson(originalDb);
    const remote = cloneJson(remoteDb);
    if (!original?.characters || !remote?.characters) return remote;

    const hiddenCharacterIds = collectRemoteHiddenCharacterIds(original);
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

function isCharacterHiddenFromRemote(dbObj, chaId) {
    return collectRemoteHiddenCharacterIds(dbObj).has(chaId);
}

function isChatHiddenFromRemote(dbObj, chaId, chatIndex, chatId) {
    if (isCharacterHiddenFromRemote(dbObj, chaId)) return true;
    const char = dbObj?.characters?.find(c => c?.chaId === chaId);
    if (!char) return false;
    const hiddenChatFolderIds = new Set(
        (char.chatFolders ?? [])
            .filter(isLocalOnlyFolder)
            .map(folder => folder?.id)
            .filter(Boolean)
    );
    if (hiddenChatFolderIds.size === 0) return false;
    const chat = chatId
        ? (char.chats ?? []).find(c => c?.id === chatId)
        : char.chats?.[chatIndex];
    return !!(chat?.folderId && hiddenChatFolderIds.has(chat.folderId));
}

module.exports = {
    filterRemoteOnlyFolders,
    isChatHiddenFromRemote,
    isCloudflareTunnelRequest,
    mergeRemoteFilteredDatabase,
};

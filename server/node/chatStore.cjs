'use strict';

const crypto = require('crypto');
const { encodeRisuSaveLegacy, normalizeJSON } = require('./utils.cjs');
const { characterToPersistentShape } = require('./persistenceShape.cjs');

const MISSING_CHAT_ETAG = 'missing';

function computeChatEtag(chat) {
    if (!chat) return MISSING_CHAT_ETAG;
    const encoded = Buffer.from(encodeRisuSaveLegacy(normalizeJSON(chat)));
    return crypto.createHash('sha256').update(encoded).digest('hex');
}

/**
 * Build the payload store used beside the stripped database cache. Hybrid
 * legacy chats (`_stub` plus messages) are repaired while being imported.
 */
function createFullChatStore(dbObj) {
    const store = new Map();
    if (!dbObj?.characters) return store;
    for (const char of dbObj.characters) {
        if (!char?.chaId || !char.chats) continue;
        const charChats = new Map();
        for (const chat of char.chats) {
            if (!chat) continue;
            const isStub = chat._stub === true;
            const hasMessage = Array.isArray(chat.message);
            if (isStub && !hasMessage) continue;
            if (isStub && hasMessage) delete chat._stub;
            if (!chat.id) chat.id = crypto.randomUUID();
            charChats.set(chat.id, chat);
        }
        if (charChats.size > 0) store.set(char.chaId, charChats);
    }
    return store;
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

function chatToStub(chat) {
    if (!chat) return chat;
    if (chat._stub && !Array.isArray(chat.message)) return chat;
    const stub = {
        id: chat.id || '',
        name: chat.name ?? '',
        _stub: true,
    };
    // Key presence distinguishes an explicit clear from an absent update.
    if ('lastDate' in chat) stub.lastDate = chat.lastDate;
    if ('folderId' in chat) stub.folderId = chat.folderId;
    if ('modules' in chat) stub.modules = chat.modules;
    return stub;
}

function stripChatsFromDb(dbObj) {
    if (!dbObj?.characters) return dbObj;
    const stripped = { ...dbObj };
    stripped.characters = dbObj.characters.map(char => {
        if (!char?.chats) return characterToPersistentShape(char);
        return {
            ...characterToPersistentShape(char),
            chats: char.chats.map(chatToStub),
        };
    });
    return stripped;
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
    if ('lastDate' in stub) merged.lastDate = stub.lastDate;
    if ('folderId' in stub) merged.folderId = stub.folderId;
    if ('modules' in stub) merged.modules = stub.modules;
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

function findStubFlagLossChats(fullDb) {
    if (!fullDb?.characters) return [];
    const losses = [];
    for (let ci = 0; ci < fullDb.characters.length; ci++) {
        const char = fullDb.characters[ci];
        if (!char?.chats) continue;
        for (let chi = 0; chi < char.chats.length; chi++) {
            const chat = char.chats[chi];
            if (!chat || typeof chat !== 'object') continue;
            if (chat._stub !== true && !Array.isArray(chat.message)) {
                losses.push({
                    chaId: char.chaId,
                    charIndex: ci,
                    chatIndex: chi,
                    chatId: chat.id || null,
                });
            }
        }
    }
    return losses;
}

module.exports = {
    MISSING_CHAT_ETAG,
    computeChatEtag,
    createFullChatStore,
    commitChatContent,
    chatToStub,
    stripChatsFromDb,
    mergeChatStubWithFullChat,
    reassembleFullDb,
    findStubFlagLossChats,
};

'use strict';

const { isChatHiddenFromRemote } = require('../remoteDatabaseFilter.cjs');
const { encodeRisuSaveLegacy, decodeRisuSave } = require('../utils.cjs');
const { computeChatEtag, CanonicalChatCommitError } = require('../chatStore.cjs');
const { readChatCompatibility, stripChatCompatibility } = require('../bookmarkStore.cjs');
const { binaryBodyParser } = require('../binaryHttp.cjs');

function installChatsRoutes(app, {
    checkAuth,
    ensureCanonicalStorage,
    isCloudflareTunnelRequest,
    appDataStore,
    ensureChatStore,
    storageState,
    restoreColdStorageChat,
    requireSyncClientId,
    canonicalChatService,
    getSyncClientIdFromRequest,
    bookmarkStore,
    broadcastBookmarksInvalidated,
}) {
    app.get('/api/chat-content/:chaId/:chatIndex', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        try {
            const chaId = req.params.chaId;
            const chatIndex = parseInt(req.params.chatIndex, 10);
            const expectedChatId = req.headers['x-chat-id'];

            await ensureCanonicalStorage();
            if (isCloudflareTunnelRequest(req)) {
                const dbObj = appDataStore.exportProjection({ includeMessages: false });
                if (isChatHiddenFromRemote(dbObj, chaId, chatIndex, expectedChatId)) {
                    return res.status(404).json({ error: 'Chat not found' });
                }
            }
            const indexedStub = appDataStore.getChatStubAt(chaId, chatIndex);
            const resolvedChatId = expectedChatId || indexedStub?.id;
            if (!indexedStub || !resolvedChatId) {
                return res.status(404).json({ error: 'Chat not found' });
            }
            // Verify chatId matches if provided
            if (expectedChatId && indexedStub.id !== expectedChatId) {
                return res.status(409).json({ error: 'Chat ID mismatch — index may have shifted' });
            }
            await ensureChatStore(chaId, resolvedChatId);
            const chat = storageState.fullChatStore.get(chaId)?.get(resolvedChatId);
            if (!chat) return res.status(404).json({ error: 'Chat not found' });
            if (!restoreColdStorageChat(chat)) {
                return res.status(500).json({ error: 'Cold storage restore failed' });
            }
            const encoded = Buffer.from(encodeRisuSaveLegacy(chat));
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('x-chat-etag', computeChatEtag(chat));
            res.send(encoded);
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/chat-content/:chaId/:chatIndex', binaryBodyParser('2gb'), async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;
        try {
            const chaId = req.params.chaId;
            const chatIndex = parseInt(req.params.chatIndex, 10);
            const expectedChatId = req.headers['x-chat-id'];
            let chatData;
            if (Buffer.isBuffer(req.body)) {
                try {
                    chatData = await decodeRisuSave(req.body);
                } catch {
                    return res.status(400).json({ error: 'Invalid binary chat data' });
                }
            } else {
                chatData = req.body;
            }

            if (!chatData || !expectedChatId) {
                return res.status(400).json({ error: 'Chat data and x-chat-id required' });
            }

            // Original-compatible imports may carry bookmark fields inside the
            // chat. Absorb them once into the server table, while keeping the
            // canonical full-chat payload free of a second bookmark source.
            const importedBookmarks = readChatCompatibility(chatData);
            stripChatCompatibility(chatData);

            if (isCloudflareTunnelRequest(req)) {
                const dbObj = appDataStore.exportProjection({ includeMessages: false });
                if (isChatHiddenFromRemote(dbObj, chaId, chatIndex, expectedChatId)) {
                    return res.status(404).json({ error: 'Chat not found' });
                }
            }

            const commit = await canonicalChatService.commitUserEdit({
                characterId: chaId,
                chatId: expectedChatId,
                chat: chatData,
                expectedEtag: req.headers['x-chat-if-match'],
                originClientId: getSyncClientIdFromRequest(req),
            });
            if (importedBookmarks) {
                if (bookmarkStore.replaceChatCompatibility(chaId, expectedChatId, importedBookmarks)) {
                    broadcastBookmarksInvalidated(req);
                }
            }
            else {
                const validMessageIds = new Set(
                    (chatData.message ?? []).map(message => message?.chatId).filter(Boolean),
                );
                if (bookmarkStore.pruneChatMessages(chaId, expectedChatId, validMessageIds) > 0) {
                    broadcastBookmarksInvalidated(req);
                }
            }
            res.json({ success: true, etag: commit.etag });
        } catch (error) {
            if (error instanceof CanonicalChatCommitError) {
                return res.status(error.httpStatus).json({
                    error: error.message,
                    ...(error.currentEtag ? { currentEtag: error.currentEtag } : {}),
                    ...(error.conflicts ? { conflicts: error.conflicts } : {}),
                    ...(error.code ? { code: error.code } : {}),
                });
            }
            next(error);
        }
    });
}

module.exports = { installChatsRoutes };

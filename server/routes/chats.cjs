'use strict';

const { isChatHidden } = require('../privacyGuardFilter.cjs');
const { encodeRisuSaveLegacy } = require('../utils/risuSave.cjs');
const { CanonicalChatCommitError } = require('../chatStore.cjs');
const { codes, sendApiError } = require('../utils/apiErrors.cjs');

function installChatsRoutes(app, {
    checkAuth,
    ensureCanonicalStorage,
    isPrivacyGuardActive,
    appDataStore,
    loadCanonicalChat,
    requireSyncClientId,
    canonicalChatService,
    getSyncClientIdFromRequest,
    bookmarkStore,
    broadcastBookmarksInvalidated,
}) {
    const sendChatNotFound = res => sendApiError(res, 404, codes.CHAT_NOT_FOUND);
    const isGuardedChat = (chaId, chatIndex, chatId) => isPrivacyGuardActive()
        && isChatHidden(appDataStore.exportFolderProjection(), chaId, chatIndex, chatId);

    app.get('/api/chat-content/:chaId/:chatIndex', async (req, res) => {
        if (!await checkAuth(req, res)) { return; }
        const chaId = req.params.chaId;
        const chatIndex = parseInt(req.params.chatIndex, 10);
        const expectedChatId = req.headers['x-chat-id'];

        await ensureCanonicalStorage();
        if (isGuardedChat(chaId, chatIndex, expectedChatId)) return sendChatNotFound(res);
        const indexedStub = appDataStore.getChatStubAt(chaId, chatIndex);
        const resolvedChatId = expectedChatId || indexedStub?.id;
        if (!resolvedChatId || !appDataStore.hasChat(chaId, resolvedChatId)) {
            return sendChatNotFound(res);
        }
        const current = await loadCanonicalChat(chaId, resolvedChatId);
        if (!current) return sendChatNotFound(res);
        if (current.coldRestoreFailed) {
            return sendApiError(res, 500, codes.CHAT_RESTORE_FAILED);
        }
        const encoded = Buffer.from(encodeRisuSaveLegacy(current.chat));
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('x-chat-etag', current.etag);
        res.send(encoded);
    });

    app.patch('/api/chat-content/:chaId/:chatIndex', async (req, res, next) => {
        if (!await checkAuth(req, res)) { return; }
        if (!requireSyncClientId(req, res)) return;
        try {
            const chaId = req.params.chaId;
            const chatIndex = parseInt(req.params.chatIndex, 10);
            const expectedChatId = req.headers['x-chat-id'];
            const changes = req.body?.changes;

            if (!Array.isArray(changes) || typeof expectedChatId !== 'string' || !expectedChatId) {
                return res.status(400).json({ error: 'Chat changes and x-chat-id required' });
            }

            if (isGuardedChat(chaId, chatIndex, expectedChatId)) return sendChatNotFound(res);

            const commit = await canonicalChatService.commitUserDelta({
                characterId: chaId,
                chatId: expectedChatId,
                changes,
                originClientId: getSyncClientIdFromRequest(req),
            });
            const validMessageIds = new Set(
                (commit.chat.message ?? []).map(message => message?.chatId).filter(Boolean),
            );
            if (bookmarkStore.pruneChatMessages(chaId, expectedChatId, validMessageIds) > 0) {
                broadcastBookmarksInvalidated(req);
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

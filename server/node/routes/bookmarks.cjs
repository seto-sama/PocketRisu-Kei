'use strict';

const { filterRemoteOnlyFolders } = require('../remoteDatabaseFilter.cjs');
const { normalizePreview } = require('../bookmarkStore.cjs');

function installBookmarksRoutes(app, {
    isCloudflareTunnelRequest,
    ensureCanonicalStorage,
    appDataStore,
    checkAuth,
    bookmarkStore,
    requireSyncClientId,
    ensureChatStore,
    storageState,
    broadcastBookmarksInvalidated,
}) {
    const BOOKMARKS_API_PATH = '/api/bookmarks';

    const BOOKMARK_TAGS_API_PATH = '/api/bookmark-tags';

    async function visibleBookmarkChatKeys(req) {
        if (!isCloudflareTunnelRequest(req)) return null;
        await ensureCanonicalStorage();
        if (!appDataStore.getState().initialized) return new Set();
        const database = appDataStore.exportProjection({ includeMessages: false });
        const visibleDatabase = filterRemoteOnlyFolders(database);
        const visible = new Set();
        for (const character of visibleDatabase?.characters ?? []) {
            for (const chat of character?.chats ?? []) {
                if (character?.chaId && chat?.id) visible.add(`${character.chaId}\u0000${chat.id}`);
            }
        }
        return visible;
    }

    function isVisibleBookmarkTarget(visible, characterId, chatId) {
        return !visible || visible.has(`${characterId}\u0000${chatId}`);
    }

    function filterBookmarkCatalogForVisibleChats(catalog, visible) {
        if (!visible) return catalog;
        const entries = catalog.entries.filter(entry =>
            isVisibleBookmarkTarget(visible, entry.characterId, entry.chatId));
        const tagIds = new Set(entries.flatMap(entry => entry.tagIds));
        return {
            ...catalog,
            entries,
            tags: catalog.tags.filter(tag => tagIds.has(tag.id)),
        };
    }

    app.get(BOOKMARKS_API_PATH, async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            await ensureCanonicalStorage();
            bookmarkStore.pruneInvalid((entry) =>
                appDataStore.hasChat(entry.characterId, entry.chatId));
            const visible = await visibleBookmarkChatKeys(req);
            res.json(filterBookmarkCatalogForVisibleChats(bookmarkStore.catalog(), visible));
        } catch (error) { next(error); }
    });

    app.put(BOOKMARKS_API_PATH, async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            const { characterId, chatId, messageId } = req.body ?? {};
            await ensureChatStore(characterId, chatId);
            const visible = await visibleBookmarkChatKeys(req);
            if (!isVisibleBookmarkTarget(visible, characterId, chatId)) {
                return res.status(404).json({ error: 'Bookmark target not found' });
            }
            const chat = storageState.fullChatStore.get(characterId)?.get(chatId);
            const message = chat?.message?.find(value => value?.chatId === messageId);
            if (!chat || !message) return res.status(404).json({ error: 'Bookmark target not found' });
            bookmarkStore.upsertBookmarkEntry({
                characterId,
                chatId,
                messageId,
                name: typeof req.body?.name === 'string' ? req.body.name.trim() : '',
                preview: normalizePreview(message.data, messageId),
                tagIds: Array.isArray(req.body?.tagIds) ? req.body.tagIds : [],
            });
            broadcastBookmarksInvalidated(req);
            res.json(filterBookmarkCatalogForVisibleChats(bookmarkStore.catalog(), visible));
        } catch (error) { next(error); }
    });

    app.patch(BOOKMARKS_API_PATH, async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            await ensureCanonicalStorage();
            const { characterId, chatId, messageId } = req.body ?? {};
            const visible = await visibleBookmarkChatKeys(req);
            if (!isVisibleBookmarkTarget(visible, characterId, chatId)) {
                return res.status(404).json({ error: 'Bookmark not found' });
            }
            const patch = {};
            if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'name')) {
                patch.name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
            }
            if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'tagIds')) {
                patch.tagIds = Array.isArray(req.body.tagIds) ? req.body.tagIds : [];
            }
            if (!bookmarkStore.patchBookmarkEntry({ characterId, chatId, messageId }, patch)) {
                return res.status(404).json({ error: 'Bookmark not found' });
            }
            broadcastBookmarksInvalidated(req);
            res.json(filterBookmarkCatalogForVisibleChats(bookmarkStore.catalog(), visible));
        } catch (error) { next(error); }
    });

    app.delete(BOOKMARKS_API_PATH, async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            await ensureCanonicalStorage();
            const { characterId, chatId, messageId } = req.body ?? {};
            const visible = await visibleBookmarkChatKeys(req);
            if (!isVisibleBookmarkTarget(visible, characterId, chatId)) {
                return res.status(404).json({ error: 'Bookmark not found' });
            }
            if (!bookmarkStore.removeBookmarkEntry({ characterId, chatId, messageId })) {
                return res.status(404).json({ error: 'Bookmark not found' });
            }
            broadcastBookmarksInvalidated(req);
            res.json(filterBookmarkCatalogForVisibleChats(bookmarkStore.catalog(), visible));
        } catch (error) { next(error); }
    });

    app.put(BOOKMARK_TAGS_API_PATH, async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            if (isCloudflareTunnelRequest(req)) {
                return res.status(403).json({ error: 'Bookmark tags are local-only' });
            }
            await ensureCanonicalStorage();
            bookmarkStore.replaceTags(req.body?.tags);
            broadcastBookmarksInvalidated(req);
            res.json(bookmarkStore.catalog());
        } catch (error) { next(error); }
    });

    app.post(`${BOOKMARK_TAGS_API_PATH}/merge`, async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        try {
            if (isCloudflareTunnelRequest(req)) {
                return res.status(403).json({ error: 'Bookmark tags are local-only' });
            }
            await ensureCanonicalStorage();
            const idMap = bookmarkStore.mergeTags(req.body?.tags);
            broadcastBookmarksInvalidated(req);
            res.json({ idMap, catalog: bookmarkStore.catalog() });
        } catch (error) { next(error); }
    });

    app.post(`${BOOKMARKS_API_PATH}/compatibility`, async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        try {
            await ensureCanonicalStorage();
            const targets = Array.isArray(req.body?.targets) ? req.body.targets : null;
            if (!targets) return res.status(400).json({ error: 'Invalid bookmark targets' });
            const visible = await visibleBookmarkChatKeys(req);
            res.json(bookmarkStore.compatibilityForTargets(targets.filter(target =>
                isVisibleBookmarkTarget(visible, target?.characterId, target?.chatId))));
        } catch (error) { next(error); }
    });
}

module.exports = { installBookmarksRoutes };

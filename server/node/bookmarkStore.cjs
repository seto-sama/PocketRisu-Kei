'use strict';

const { randomUUID } = require('crypto');

const LEGACY_MIGRATION_KEY = 'legacy-chat-bookmarks-v1';

function normalizePreview(value, messageId) {
    const compact = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!compact) return messageId;
    return compact.length > 50 ? `${compact.slice(0, 50)}…` : compact;
}

function readChatCompatibility(chat, options = {}) {
    if (!chat || typeof chat !== 'object') return null;
    const includeFolderData = options.includeFolderData !== false;
    const hadFields = Object.prototype.hasOwnProperty.call(chat, 'bookmarks')
        || Object.prototype.hasOwnProperty.call(chat, 'bookmarkNames')
        || (includeFolderData
            && Object.prototype.hasOwnProperty.call(chat, 'bookmarkFolderIds'));
    if (!hadFields) return null;

    const messages = new Map(
        (Array.isArray(chat.message) ? chat.message : [])
            .filter(message => typeof message?.chatId === 'string' && message.chatId)
            .map(message => [message.chatId, message]),
    );
    const seen = new Set();
    const bookmarks = [];
    for (const messageId of Array.isArray(chat.bookmarks) ? chat.bookmarks : []) {
        if (typeof messageId !== 'string' || !messageId || seen.has(messageId)) continue;
        const message = messages.get(messageId);
        if (!message) continue;
        seen.add(messageId);
        const customName = typeof chat.bookmarkNames?.[messageId] === 'string'
            && chat.bookmarkNames[messageId]
            ? chat.bookmarkNames[messageId]
            : null;
        const folderId = includeFolderData
            && typeof chat.bookmarkFolderIds?.[messageId] === 'string'
            && chat.bookmarkFolderIds[messageId]
            ? chat.bookmarkFolderIds[messageId]
            : null;
        bookmarks.push({
            messageId,
            customName,
            preview: normalizePreview(message.data, messageId),
            folderId,
        });
    }
    return bookmarks;
}

function stripChatCompatibility(chat) {
    if (!chat || typeof chat !== 'object') return false;
    let changed = false;
    for (const key of ['bookmarks', 'bookmarkNames', 'bookmarkFolderIds']) {
        if (Object.prototype.hasOwnProperty.call(chat, key)) {
            delete chat[key];
            changed = true;
        }
    }
    return changed;
}

function createBookmarkStore(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS bookmark_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bookmark_folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bookmarks (
            character_id TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            custom_name TEXT,
            preview TEXT NOT NULL,
            folder_id TEXT,
            PRIMARY KEY (character_id, chat_id, message_id)
        );
        CREATE TABLE IF NOT EXISTS bookmark_snapshots (
            snapshot_key TEXT PRIMARY KEY,
            catalog_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bookmarks_chat
            ON bookmarks(character_id, chat_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_folder
            ON bookmarks(folder_id);
        DROP INDEX IF EXISTS idx_bookmarks_catalog;
    `);

    const getMeta = db.prepare('SELECT value FROM bookmark_meta WHERE key = ?');
    const setMeta = db.prepare(`
        INSERT INTO bookmark_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const listFoldersStatement = db.prepare(
        'SELECT id, name FROM bookmark_folders ORDER BY sort_order, rowid',
    );
    const listBookmarksStatement = db.prepare(`
        SELECT character_id AS characterId, chat_id AS chatId,
               message_id AS messageId, custom_name AS customName,
               preview, folder_id AS folderId, sort_order AS sortOrder
        FROM bookmarks
        ORDER BY rowid
    `);
    const listChatBookmarksStatement = db.prepare(`
        SELECT message_id AS messageId, custom_name AS customName,
               preview, folder_id AS folderId, sort_order AS sortOrder
        FROM bookmarks
        WHERE character_id = ? AND chat_id = ?
        ORDER BY sort_order, rowid
    `);
    const deleteChatBookmarks = db.prepare(
        'DELETE FROM bookmarks WHERE character_id = ? AND chat_id = ?',
    );
    const insertBookmark = db.prepare(`
        INSERT INTO bookmarks(
            character_id, chat_id, message_id, sort_order,
            custom_name, preview, folder_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(character_id, chat_id, message_id) DO UPDATE SET
            sort_order = excluded.sort_order,
            custom_name = excluded.custom_name,
            preview = excluded.preview,
            folder_id = excluded.folder_id
    `);
    const deleteBookmarkStatement = db.prepare(`
        DELETE FROM bookmarks
        WHERE character_id = ? AND chat_id = ? AND message_id = ?
    `);
    const getBookmarkStatement = db.prepare(`
        SELECT character_id AS characterId, chat_id AS chatId,
               message_id AS messageId, custom_name AS customName,
               preview, folder_id AS folderId, sort_order AS sortOrder
        FROM bookmarks
        WHERE character_id = ? AND chat_id = ? AND message_id = ?
    `);
    const nextBookmarkOrderStatement = db.prepare(
        'SELECT COALESCE(MAX(sort_order) + 1, 0) AS value FROM bookmarks',
    );
    const getFolderStatement = db.prepare('SELECT 1 FROM bookmark_folders WHERE id = ?');
    const clearBookmarksStatement = db.prepare('DELETE FROM bookmarks');
    const clearFoldersStatement = db.prepare('DELETE FROM bookmark_folders');
    const clearBookmarkFolderStatement = db.prepare(
        'UPDATE bookmarks SET folder_id = NULL WHERE folder_id = ?',
    );
    const deleteFolderStatement = db.prepare('DELETE FROM bookmark_folders WHERE id = ?');
    const upsertFolderStatement = db.prepare(`
        INSERT INTO bookmark_folders(id, name, sort_order) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order
    `);
    const insertFolderStatement = db.prepare(
        'INSERT INTO bookmark_folders(id, name, sort_order) VALUES (?, ?, ?)',
    );
    const saveSnapshotStatement = db.prepare(`
        INSERT INTO bookmark_snapshots(snapshot_key, catalog_json) VALUES (?, ?)
        ON CONFLICT(snapshot_key) DO UPDATE SET catalog_json = excluded.catalog_json
    `);
    const getSnapshotStatement = db.prepare(
        'SELECT catalog_json AS catalogJson FROM bookmark_snapshots WHERE snapshot_key = ?',
    );
    const deleteSnapshotStatement = db.prepare(
        'DELETE FROM bookmark_snapshots WHERE snapshot_key = ?',
    );

    function revision() {
        return Number(getMeta.get('revision')?.value ?? 0) || 0;
    }

    function bumpRevision() {
        const next = revision() + 1;
        setMeta.run('revision', String(next));
        return next;
    }

    function catalog() {
        return {
            revision: revision(),
            folders: listFoldersStatement.all(),
            entries: listBookmarksStatement.all().map(entry => ({
                ...entry,
                name: entry.customName || entry.preview || entry.messageId,
            })),
        };
    }

    function normalizeFolders(folders) {
        const normalized = [];
        const ids = new Set();
        for (const folder of Array.isArray(folders) ? folders : []) {
            const id = typeof folder?.id === 'string' ? folder.id.trim() : '';
            const name = typeof folder?.name === 'string' ? folder.name.trim() : '';
            if (!id || !name || ids.has(id)) continue;
            ids.add(id);
            normalized.push({ id, name });
        }
        return normalized;
    }

    function validFolderId(folderId) {
        return typeof folderId === 'string' && folderId && getFolderStatement.get(folderId)
            ? folderId
            : null;
    }

    const replaceChat = db.transaction((characterId, chatId, bookmarks) => {
        const normalized = bookmarks.map((bookmark, index) => ({
            messageId: bookmark.messageId,
            customName: bookmark.customName ?? null,
            preview: normalizePreview(bookmark.preview, bookmark.messageId),
            folderId: validFolderId(bookmark.folderId),
            sortOrder: index,
        }));
        const current = listChatBookmarksStatement.all(characterId, chatId);
        if (JSON.stringify(current) === JSON.stringify(normalized)) return false;
        deleteChatBookmarks.run(characterId, chatId);
        for (const bookmark of normalized) {
            insertBookmark.run(
                characterId,
                chatId,
                bookmark.messageId,
                bookmark.sortOrder,
                bookmark.customName,
                bookmark.preview,
                bookmark.folderId,
            );
        }
        bumpRevision();
        return true;
    });

    function replaceChatCompatibility(characterId, chatId, bookmarks) {
        if (!characterId || !chatId || !Array.isArray(bookmarks)) return false;
        return replaceChat(characterId, chatId, bookmarks);
    }

    const upsertBookmarkTransaction = db.transaction((entry) => {
        const current = getBookmarkStatement.get(
            entry.characterId,
            entry.chatId,
            entry.messageId,
        );
        const nextOrder = current?.sortOrder ?? nextBookmarkOrderStatement.get().value;
        insertBookmark.run(
            entry.characterId,
            entry.chatId,
            entry.messageId,
            nextOrder,
            entry.name || null,
            entry.preview || entry.messageId,
            validFolderId(entry.folderId),
        );
        bumpRevision();
    });

    function upsertBookmarkEntry(entry) {
        if (!entry?.characterId || !entry.chatId || !entry.messageId) return false;
        upsertBookmarkTransaction(entry);
        return true;
    }

    const patchBookmarkTransaction = db.transaction((target, patch) => {
        const current = getBookmarkStatement.get(
            target.characterId,
            target.chatId,
            target.messageId,
        );
        if (!current) return false;
        insertBookmark.run(
            current.characterId,
            current.chatId,
            current.messageId,
            current.sortOrder,
            Object.prototype.hasOwnProperty.call(patch, 'name')
                ? (patch.name || null)
                : current.customName,
            current.preview,
            Object.prototype.hasOwnProperty.call(patch, 'folderId')
                ? validFolderId(patch.folderId)
                : current.folderId,
        );
        bumpRevision();
        return true;
    });

    function patchBookmarkEntry(target, patch) {
        return patchBookmarkTransaction(target, patch ?? {});
    }

    const removeBookmarkTransaction = db.transaction((target) => {
        const result = deleteBookmarkStatement.run(
            target.characterId,
            target.chatId,
            target.messageId,
        );
        if (result.changes > 0) bumpRevision();
        return result.changes > 0;
    });

    function removeBookmarkEntry(target) {
        if (!target?.characterId || !target.chatId || !target.messageId) return false;
        return removeBookmarkTransaction(target);
    }

    const replaceFoldersTransaction = db.transaction((folders) => {
        const currentFolders = listFoldersStatement.all();
        if (JSON.stringify(currentFolders) === JSON.stringify(folders)) return false;
        const incomingIds = new Set(folders.map(folder => folder.id));
        for (const current of currentFolders) {
            if (!incomingIds.has(current.id)) {
                clearBookmarkFolderStatement.run(current.id);
                deleteFolderStatement.run(current.id);
            }
        }
        folders.forEach((folder, index) => upsertFolderStatement.run(folder.id, folder.name, index));
        bumpRevision();
        return true;
    });

    function replaceFolders(folders) {
        const normalized = normalizeFolders(folders);
        replaceFoldersTransaction(normalized);
        return normalized;
    }

    const mergeFoldersTransaction = db.transaction((incoming) => {
        const folders = listFoldersStatement.all();
        const byId = new Map(folders.map(folder => [folder.id, folder]));
        const idMap = {};
        let sortOrder = folders.length;
        let changed = false;
        for (const value of normalizeFolders(incoming)) {
            const originalId = value.id;
            const name = value.name;
            const current = byId.get(originalId);
            if (!current || current.name === name) {
                if (!current) {
                    const folder = { id: originalId, name };
                    insertFolderStatement.run(folder.id, folder.name, sortOrder++);
                    byId.set(folder.id, folder);
                    changed = true;
                }
                idMap[originalId] = originalId;
                continue;
            }
            let nextId = randomUUID();
            while (byId.has(nextId)) nextId = randomUUID();
            insertFolderStatement.run(nextId, name, sortOrder++);
            byId.set(nextId, { id: nextId, name });
            idMap[originalId] = nextId;
            changed = true;
        }
        if (changed) bumpRevision();
        return idMap;
    });

    function mergeFolders(incoming) {
        return mergeFoldersTransaction(incoming);
    }

    function compatibilityForTargets(targets) {
        const entries = [];
        const referencedFolderIds = new Set();
        for (const target of Array.isArray(targets) ? targets : []) {
            if (!target?.characterId || !target.chatId) continue;
            const rows = listChatBookmarksStatement.all(target.characterId, target.chatId);
            const bookmarkNames = {};
            const bookmarkFolderIds = {};
            for (const row of rows) {
                if (row.customName) bookmarkNames[row.messageId] = row.customName;
                if (row.folderId) {
                    bookmarkFolderIds[row.messageId] = row.folderId;
                    referencedFolderIds.add(row.folderId);
                }
            }
            entries.push({
                characterId: target.characterId,
                chatId: target.chatId,
                data: {
                    bookmarks: rows.map(row => row.messageId),
                    ...(Object.keys(bookmarkNames).length > 0 ? { bookmarkNames } : {}),
                    ...(Object.keys(bookmarkFolderIds).length > 0 ? { bookmarkFolderIds } : {}),
                },
            });
        }
        return {
            entries,
            folders: listFoldersStatement.all().filter(folder => referencedFolderIds.has(folder.id)),
        };
    }

    function projectDatabaseCompatibility(database) {
        if (!database || typeof database !== 'object') return database;
        database.bookmarkFolders = listFoldersStatement.all();
        for (const character of Array.isArray(database.characters) ? database.characters : []) {
            if (!character?.chaId) continue;
            for (const chat of Array.isArray(character.chats) ? character.chats : []) {
                if (!chat?.id) continue;
                stripChatCompatibility(chat);
                const rows = listChatBookmarksStatement.all(character.chaId, chat.id);
                if (rows.length === 0) continue;
                chat.bookmarks = rows.map(row => row.messageId);
                const bookmarkNames = {};
                const bookmarkFolderIds = {};
                for (const row of rows) {
                    if (row.customName) bookmarkNames[row.messageId] = row.customName;
                    if (row.folderId) bookmarkFolderIds[row.messageId] = row.folderId;
                }
                if (Object.keys(bookmarkNames).length > 0) chat.bookmarkNames = bookmarkNames;
                if (Object.keys(bookmarkFolderIds).length > 0) {
                    chat.bookmarkFolderIds = bookmarkFolderIds;
                }
            }
        }
        return database;
    }

    const pruneInvalidTransaction = db.transaction((isValid) => {
        let removed = 0;
        for (const entry of listBookmarksStatement.all()) {
            if (isValid(entry)) continue;
            removed += deleteBookmarkStatement.run(
                entry.characterId,
                entry.chatId,
                entry.messageId,
            ).changes;
        }
        if (removed > 0) bumpRevision();
        return removed;
    });

    function pruneInvalid(isValid) {
        return typeof isValid === 'function' ? pruneInvalidTransaction(isValid) : 0;
    }

    const pruneChatMessagesTransaction = db.transaction((characterId, chatId, messageIds) => {
        let removed = 0;
        for (const entry of listChatBookmarksStatement.all(characterId, chatId)) {
            if (messageIds.has(entry.messageId)) continue;
            removed += deleteBookmarkStatement.run(characterId, chatId, entry.messageId).changes;
        }
        if (removed > 0) bumpRevision();
        return removed;
    });

    function pruneChatMessages(characterId, chatId, messageIds) {
        if (!characterId || !chatId || !(messageIds instanceof Set)) return 0;
        return pruneChatMessagesTransaction(characterId, chatId, messageIds);
    }

    function stripDatabaseCompatibility(database) {
        let changed = false;
        if (Object.prototype.hasOwnProperty.call(database ?? {}, 'bookmarkFolders')) {
            delete database.bookmarkFolders;
            changed = true;
        }
        for (const character of Array.isArray(database?.characters) ? database.characters : []) {
            for (const chat of Array.isArray(character?.chats) ? character.chats : []) {
                changed = stripChatCompatibility(chat) || changed;
            }
        }
        return changed;
    }

    function ingestDatabaseCompatibility(database, options = {}) {
        const replaceExisting = options.replaceExisting === true;
        const includeFolderData = options.includeFolderData === true;
        if (replaceExisting) {
            clearBookmarksStatement.run();
            clearFoldersStatement.run();
        }
        if (includeFolderData) {
            const folders = normalizeFolders(database?.bookmarkFolders);
            if (replaceExisting || listFoldersStatement.all().length === 0) {
                folders.forEach((folder, index) => {
                    upsertFolderStatement.run(folder.id, folder.name, index);
                });
            }
        }
        let importedChats = 0;
        for (const character of Array.isArray(database?.characters) ? database.characters : []) {
            if (!character?.chaId) continue;
            for (const chat of Array.isArray(character.chats) ? character.chats : []) {
                if (!chat?.id) continue;
                const compatibility = readChatCompatibility(chat, { includeFolderData });
                if (!compatibility) continue;
                deleteChatBookmarks.run(character.chaId, chat.id);
                compatibility.forEach((bookmark, index) => insertBookmark.run(
                    character.chaId,
                    chat.id,
                    bookmark.messageId,
                    index,
                    bookmark.customName,
                    bookmark.preview,
                    validFolderId(bookmark.folderId),
                ));
                importedChats += 1;
            }
        }
        return importedChats;
    }

    const migrateTransaction = db.transaction((database) => {
        const migrationComplete = getMeta.get(LEGACY_MIGRATION_KEY)?.value === '1';
        if (!migrationComplete) {
            // Only the upstream legacy bookmark fields were ever released.
            // The experimental folder fields were not, so startup migration
            // deliberately imports bookmarks/names without folder metadata.
            ingestDatabaseCompatibility(database, {
                replaceExisting: false,
                includeFolderData: false,
            });
            setMeta.run(LEGACY_MIGRATION_KEY, '1');
            bumpRevision();
        }
        const changed = stripDatabaseCompatibility(database);
        return { changed, migrated: !migrationComplete };
    });

    function migrateLegacyDatabase(database) {
        return migrateTransaction(database);
    }

    const replaceDatabaseTransaction = db.transaction((database) => {
        const importedChats = ingestDatabaseCompatibility(database, {
            replaceExisting: true,
            includeFolderData: true,
        });
        setMeta.run(LEGACY_MIGRATION_KEY, '1');
        bumpRevision();
        return {
            changed: stripDatabaseCompatibility(database),
            migrated: true,
            importedChats,
        };
    });

    function replaceDatabaseCompatibility(database) {
        return replaceDatabaseTransaction(database);
    }

    const replaceCatalogTransaction = db.transaction((value) => {
        clearBookmarksStatement.run();
        clearFoldersStatement.run();
        const folders = normalizeFolders(value?.folders);
        folders.forEach((folder, index) => {
            insertFolderStatement.run(folder.id, folder.name, index);
        });
        let sortOrder = 0;
        for (const entry of Array.isArray(value?.entries) ? value.entries : []) {
            if (!entry?.characterId || !entry.chatId || !entry.messageId) continue;
            insertBookmark.run(
                entry.characterId,
                entry.chatId,
                entry.messageId,
                Number.isFinite(entry.sortOrder) ? entry.sortOrder : sortOrder,
                typeof entry.customName === 'string' && entry.customName
                    ? entry.customName
                    : null,
                normalizePreview(entry.preview, entry.messageId),
                validFolderId(entry.folderId),
            );
            sortOrder += 1;
        }
        bumpRevision();
    });

    function saveSnapshot(snapshotKey) {
        if (typeof snapshotKey !== 'string' || !snapshotKey) return false;
        // Before the one-time migration finishes, the raw snapshot still owns
        // its compatible bookmark fields. Let restore fall back to those.
        if (getMeta.get(LEGACY_MIGRATION_KEY)?.value !== '1') return false;
        saveSnapshotStatement.run(snapshotKey, JSON.stringify(catalog()));
        return true;
    }

    function restoreSnapshot(snapshotKey) {
        const serialized = getSnapshotStatement.get(snapshotKey)?.catalogJson;
        if (!serialized) return false;
        try {
            replaceCatalogTransaction(JSON.parse(serialized));
            return true;
        } catch {
            return false;
        }
    }

    function deleteSnapshot(snapshotKey) {
        return deleteSnapshotStatement.run(snapshotKey).changes > 0;
    }

    return {
        catalog,
        upsertBookmarkEntry,
        patchBookmarkEntry,
        removeBookmarkEntry,
        replaceChatCompatibility,
        replaceFolders,
        mergeFolders,
        compatibilityForTargets,
        projectDatabaseCompatibility,
        pruneInvalid,
        pruneChatMessages,
        migrateLegacyDatabase,
        replaceDatabaseCompatibility,
        saveSnapshot,
        restoreSnapshot,
        deleteSnapshot,
    };
}

module.exports = {
    createBookmarkStore,
    normalizePreview,
    readChatCompatibility,
    stripChatCompatibility,
};

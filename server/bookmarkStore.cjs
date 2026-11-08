'use strict';

const { withTransaction } = require('./sqlite.cjs');
const { randomUUID } = require('crypto');
const LEGACY_MIGRATION_KEY = 'legacy-chat-bookmarks-v1';

function normalizePreview(value, messageId) {
    const compact = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!compact) return messageId;
    return compact.length > 50 ? `${compact.slice(0, 50)}…` : compact;
}
function normalizeTagIds(value) {
    return [...new Set((Array.isArray(value) ? value : [])
        .filter(id => typeof id === 'string').map(id => id.trim()).filter(Boolean))];
}
function readChatCompatibility(chat, options = {}) {
    if (!chat || typeof chat !== 'object') return null;
    const includeTagData = options.includeTagData !== false;
    const present = ['bookmarks', 'bookmarkNames'].some(key =>
        Object.prototype.hasOwnProperty.call(chat, key))
        || (includeTagData && Object.prototype.hasOwnProperty.call(chat, 'bookmarkTagIds'));
    if (!present) return null;
    const messages = new Map((Array.isArray(chat.message) ? chat.message : [])
        .filter(message => typeof message?.chatId === 'string' && message.chatId)
        .map(message => [message.chatId, message]));
    const seen = new Set();
    return (Array.isArray(chat.bookmarks) ? chat.bookmarks : []).flatMap(messageId => {
        if (typeof messageId !== 'string' || !messageId || seen.has(messageId)
            || !messages.has(messageId)) return [];
        seen.add(messageId);
        return [{
            messageId,
            customName: typeof chat.bookmarkNames?.[messageId] === 'string'
                && chat.bookmarkNames[messageId] ? chat.bookmarkNames[messageId] : null,
            preview: normalizePreview(messages.get(messageId).data, messageId),
            tagIds: includeTagData ? normalizeTagIds(chat.bookmarkTagIds?.[messageId]) : [],
        }];
    });
}
function stripChatCompatibility(chat) {
    if (!chat || typeof chat !== 'object') return false;
    let changed = false;
    for (const key of ['bookmarks', 'bookmarkNames', 'bookmarkTagIds']) {
        if (Object.prototype.hasOwnProperty.call(chat, key)) {
            delete chat[key];
            changed = true;
        }
    }
    return changed;
}

function createBookmarkStore(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS bookmark_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bookmark_tags (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bookmarks (
            character_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
            sort_order INTEGER NOT NULL, custom_name TEXT, preview TEXT NOT NULL,
            PRIMARY KEY (character_id, chat_id, message_id)
        );
        CREATE TABLE IF NOT EXISTS bookmark_tag_bindings (
            character_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY (character_id, chat_id, message_id, tag_id)
        );
        CREATE TABLE IF NOT EXISTS bookmark_snapshots (
            snapshot_key TEXT PRIMARY KEY, catalog_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bookmarks_chat
            ON bookmarks(character_id, chat_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_bookmark_tag_bindings_tag
            ON bookmark_tag_bindings(tag_id);
    `);
    const sql = db.createTagStore();
    const toEntry = row => row && {
        characterId: row.character_id, chatId: row.chat_id, messageId: row.message_id,
        customName: row.custom_name, preview: row.preview, sortOrder: row.sort_order,
    };
    const meta = name => sql.get`SELECT value FROM bookmark_meta WHERE key = ${name}`?.value;
    const setMeta = (name, value) => sql.run`
        INSERT INTO bookmark_meta(key, value) VALUES (${name}, ${value})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    const tagRows = () => sql.all`SELECT id, name FROM bookmark_tags ORDER BY sort_order, rowid`;
    const putTag = (tag, order) => sql.run`
        INSERT INTO bookmark_tags(id, name, sort_order) VALUES (${tag.id}, ${tag.name}, ${order})
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order`;
    const insertTag = (tag, order) =>
        sql.run`INSERT INTO bookmark_tags(id, name, sort_order) VALUES (${tag.id}, ${tag.name}, ${order})`;
    const getEntry = ({ characterId, chatId, messageId }) => toEntry(sql.get`
        SELECT * FROM bookmarks
        WHERE character_id = ${characterId} AND chat_id = ${chatId} AND message_id = ${messageId}`);
    const putEntry = ({ characterId, chatId, messageId }, sortOrder, customName, preview) => sql.run`
        INSERT INTO bookmarks(character_id, chat_id, message_id, sort_order, custom_name, preview)
        VALUES (${characterId}, ${chatId}, ${messageId}, ${sortOrder}, ${customName}, ${preview})
        ON CONFLICT(character_id, chat_id, message_id) DO UPDATE SET
            sort_order = excluded.sort_order, custom_name = excluded.custom_name, preview = excluded.preview`;
    const deleteBindings = ({ characterId, chatId, messageId }) => sql.run`
        DELETE FROM bookmark_tag_bindings
        WHERE character_id = ${characterId} AND chat_id = ${chatId} AND message_id = ${messageId}`;
    // Removes the entry and its tag bindings; returns the number of entries removed.
    function removeEntry(entry) {
        deleteBindings(entry);
        return sql.run`
            DELETE FROM bookmarks WHERE character_id = ${entry.characterId}
                AND chat_id = ${entry.chatId} AND message_id = ${entry.messageId}`.changes;
    }
    const clearAll = () => db.exec('DELETE FROM bookmark_tag_bindings; DELETE FROM bookmarks; DELETE FROM bookmark_tags');
    const snapshotCatalog = snapshotKey =>
        sql.get`SELECT catalog_json FROM bookmark_snapshots WHERE snapshot_key = ${snapshotKey}`?.catalog_json;

    const key = row => `${row.characterId}\0${row.chatId}\0${row.messageId}`;
    const revision = () => Number(meta('revision') ?? 0) || 0;
    const bump = () => setMeta('revision', String(revision() + 1));
    function normalizeTags(value) {
        const seen = new Set();
        return (Array.isArray(value) ? value : []).flatMap(tag => {
            const id = typeof tag?.id === 'string' ? tag.id.trim() : '';
            const name = typeof tag?.name === 'string' ? tag.name.trim() : '';
            if (!id || !name || seen.has(id)) return [];
            seen.add(id);
            return [{ id, name }];
        });
    }
    const validTagIds = ids => normalizeTagIds(ids)
        .filter(id => sql.get`SELECT 1 FROM bookmark_tags WHERE id = ${id}`);
    function withTags(rows, bindings) {
        const entries = rows.map(row => ({ ...toEntry(row), tagIds: [] }));
        const map = new Map(entries.map(entry => [key(entry), entry]));
        bindings.forEach(binding => map.get(key(toEntry(binding)))?.tagIds.push(binding.tag_id));
        return entries;
    }
    const chatRows = (characterId, chatId) => withTags(
        sql.all`SELECT * FROM bookmarks WHERE character_id = ${characterId} AND chat_id = ${chatId}
            ORDER BY sort_order, rowid`,
        sql.all`SELECT * FROM bookmark_tag_bindings WHERE character_id = ${characterId} AND chat_id = ${chatId}
            ORDER BY rowid`,
    );
    const allRows = () => withTags(
        sql.all`SELECT * FROM bookmarks ORDER BY rowid`,
        sql.all`SELECT * FROM bookmark_tag_bindings ORDER BY rowid`,
    );
    function catalog() {
        return {
            revision: revision(),
            tags: tagRows(),
            entries: allRows().map(row => ({
                ...row, name: row.customName || row.preview || row.messageId,
            })),
        };
    }
    function replaceBindings(entry, ids) {
        deleteBindings(entry);
        validTagIds(ids).forEach(id => sql.run`
            INSERT OR IGNORE INTO bookmark_tag_bindings (character_id, chat_id, message_id, tag_id)
            VALUES (${entry.characterId}, ${entry.chatId}, ${entry.messageId}, ${id})`);
    }
    function upsertBookmarkEntry(entry) {
        if (!entry?.characterId || !entry.chatId || !entry.messageId) return false;
        withTransaction(db, () => {
            const sortOrder = getEntry(entry)?.sortOrder
                ?? sql.get`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM bookmarks`.next;
            putEntry(entry, sortOrder, entry.name || null, normalizePreview(entry.preview, entry.messageId));
            replaceBindings(entry, entry.tagIds);
            bump();
        });
        return true;
    }
    const patchBookmarkEntry = (target, patch) => withTransaction(db, () => {
        patch ??= {};
        const row = getEntry(target);
        if (!row) return false;
        putEntry(row, row.sortOrder,
            Object.hasOwn(patch, 'name') ? patch.name || null : row.customName, row.preview);
        if (Object.hasOwn(patch, 'tagIds')) replaceBindings(row, patch.tagIds);
        bump(); return true;
    });
    const removeBookmarkEntry = target => Boolean(target?.characterId && target.chatId
        && target.messageId && withTransaction(db, () => {
            const changed = removeEntry(target) > 0;
            if (changed) bump();
            return changed;
        }));
    function replaceTags(input) {
        const tags = normalizeTags(input);
        withTransaction(db, () => {
            const current = tagRows();
            if (JSON.stringify(current) === JSON.stringify(tags)) return;
            const ids = new Set(tags.map(tag => tag.id));
            current.filter(tag => !ids.has(tag.id)).forEach(tag => {
                sql.run`DELETE FROM bookmark_tag_bindings WHERE tag_id = ${tag.id}`;
                sql.run`DELETE FROM bookmark_tags WHERE id = ${tag.id}`;
            });
            tags.forEach(putTag);
            bump();
        });
        return tags;
    }
    const mergeTags = incoming => withTransaction(db, () => {
        const existing = tagRows();
        const byId = new Map(existing.map(tag => [tag.id, tag]));
        const idMap = {};
        let order = existing.length;
        let changed = false;
        normalizeTags(incoming).forEach(tag => {
            let id = tag.id;
            if (byId.has(id) && byId.get(id).name !== tag.name) {
                id = randomUUID();
            }
            if (!byId.has(id)) {
                insertTag({ id, name: tag.name }, order++);
                byId.set(id, { id, name: tag.name });
                changed = true;
            }
            idMap[tag.id] = id;
        });
        if (changed) bump();
        return idMap;
    });
    function compatibilityForTargets(targets) {
        const entries = [];
        const used = new Set();
        (Array.isArray(targets) ? targets : []).forEach(target => {
            if (!target?.characterId || !target.chatId) return;
            const rows = chatRows(target.characterId, target.chatId);
            const bookmarkNames = {};
            const bookmarkTagIds = {};
            rows.forEach(row => {
                if (row.customName) bookmarkNames[row.messageId] = row.customName;
                if (row.tagIds.length) {
                    bookmarkTagIds[row.messageId] = row.tagIds;
                    row.tagIds.forEach(id => used.add(id));
                }
            });
            entries.push({ characterId: target.characterId, chatId: target.chatId, data: {
                bookmarks: rows.map(row => row.messageId),
                ...(Object.keys(bookmarkNames).length ? { bookmarkNames } : {}),
                ...(Object.keys(bookmarkTagIds).length ? { bookmarkTagIds } : {}),
            } });
        });
        return { entries, tags: tagRows().filter(tag => used.has(tag.id)) };
    }
    function projectCatalogCompatibility(database, value) {
        if (!database || typeof database !== 'object') return database;
        database.bookmarkTags = normalizeTags(value?.tags);
        const byChat = new Map();
        (Array.isArray(value?.entries) ? value.entries : []).forEach(row => {
            if (!row?.characterId || !row.chatId || !row.messageId) return;
            const id = `${row.characterId}\0${row.chatId}`;
            byChat.set(id, [...(byChat.get(id) ?? []), row]);
        });
        (Array.isArray(database.characters) ? database.characters : []).forEach(character =>
            (Array.isArray(character?.chats) ? character.chats : []).forEach(chat => {
                stripChatCompatibility(chat);
                const rows = byChat.get(`${character.chaId}\0${chat.id}`) ?? [];
                if (!rows.length) return;
                chat.bookmarks = rows.map(row => row.messageId);
                const names = {}, tagIds = {};
                rows.forEach(row => {
                    if (row.customName) names[row.messageId] = row.customName;
                    const ids = normalizeTagIds(row.tagIds);
                    if (ids.length) tagIds[row.messageId] = ids;
                });
                if (Object.keys(names).length) chat.bookmarkNames = names;
                if (Object.keys(tagIds).length) chat.bookmarkTagIds = tagIds;
            }));
        return database;
    }
    const projectDatabaseCompatibility = database => projectCatalogCompatibility(database, catalog());
    function projectSnapshotDatabaseCompatibility(snapshotKey, database) {
        const value = snapshotCatalog(snapshotKey);
        if (!value) return false;
        try { projectCatalogCompatibility(database, JSON.parse(value)); return true; }
        catch { return false; }
    }
    const pruneInvalid = isValid => typeof isValid !== 'function' ? 0 : withTransaction(db, () => {
        let removed = 0;
        sql.all`SELECT * FROM bookmarks ORDER BY rowid`.map(toEntry).forEach(row => {
            if (!isValid(row)) removed += removeEntry(row);
        });
        if (removed) bump();
        return removed;
    });
    const pruneChatMessages = (characterId, chatId, ids) => !(characterId && chatId && ids instanceof Set)
        ? 0 : withTransaction(db, () => {
        let removed = 0;
        chatRows(characterId, chatId).forEach(row => {
            if (!ids.has(row.messageId)) removed += removeEntry(row);
        });
        if (removed) bump();
        return removed;
    });
    function stripDatabaseCompatibility(database) {
        let changed = false;
        if (Object.hasOwn(database ?? {}, 'bookmarkTags')) {
            delete database.bookmarkTags; changed = true;
        }
        (Array.isArray(database?.characters) ? database.characters : []).forEach(character =>
            (Array.isArray(character?.chats) ? character.chats : []).forEach(chat => {
                changed = stripChatCompatibility(chat) || changed;
            }));
        return changed;
    }
    function ingest(database, { replaceExisting = false, includeTagData = false } = {}) {
        if (replaceExisting) clearAll();
        if (includeTagData && (replaceExisting || !tagRows().length)) {
            normalizeTags(database?.bookmarkTags).forEach(putTag);
        }
        let importedChats = 0;
        (Array.isArray(database?.characters) ? database.characters : []).forEach(character =>
            (Array.isArray(character?.chats) ? character.chats : []).forEach(chat => {
                const rows = readChatCompatibility(chat, { includeTagData });
                if (!character?.chaId || !chat?.id || !rows) return;
                sql.run`DELETE FROM bookmark_tag_bindings WHERE character_id = ${character.chaId} AND chat_id = ${chat.id}`;
                sql.run`DELETE FROM bookmarks WHERE character_id = ${character.chaId} AND chat_id = ${chat.id}`;
                rows.forEach((row, i) => {
                    const entry = { characterId: character.chaId, chatId: chat.id, messageId: row.messageId };
                    putEntry(entry, i, row.customName, row.preview);
                    replaceBindings(entry, row.tagIds);
                });
                importedChats++;
            }));
        return importedChats;
    }
    const migrateLegacyDatabase = database => withTransaction(db, () => {
        const complete = meta(LEGACY_MIGRATION_KEY) === '1';
        if (!complete) {
            ingest(database);
            setMeta(LEGACY_MIGRATION_KEY, '1');
            bump();
        }
        return { changed: stripDatabaseCompatibility(database), migrated: !complete };
    });
    const needsLegacyMigration = () => meta(LEGACY_MIGRATION_KEY) !== '1';
    const replaceDatabaseCompatibility = database => withTransaction(db, () => {
        const importedChats = ingest(database, { replaceExisting: true, includeTagData: true });
        setMeta(LEGACY_MIGRATION_KEY, '1'); bump();
        return { changed: stripDatabaseCompatibility(database), migrated: true, importedChats };
    });
    const replaceCatalog = value => withTransaction(db, () => {
        clearAll();
        normalizeTags(value?.tags).forEach(insertTag);
        (Array.isArray(value?.entries) ? value.entries : []).forEach((row, i) => {
            if (!row?.characterId || !row.chatId || !row.messageId) return;
            putEntry(row, Number.isFinite(row.sortOrder) ? row.sortOrder : i,
                typeof row.customName === 'string' && row.customName ? row.customName : null,
                normalizePreview(row.preview, row.messageId));
            replaceBindings(row, row.tagIds);
        });
        bump();
    });
    const saveCatalogSnapshot = (key, value) => sql.run`
        INSERT INTO bookmark_snapshots(snapshot_key, catalog_json) VALUES (${key}, ${JSON.stringify(value)})
        ON CONFLICT(snapshot_key) DO UPDATE SET catalog_json = excluded.catalog_json`;
    function saveSnapshot(key) {
        if (typeof key !== 'string' || !key || needsLegacyMigration()) return false;
        saveCatalogSnapshot(key, catalog());
        return true;
    }
    function restoreSnapshot(key) {
        const value = snapshotCatalog(key);
        if (!value) return false;
        try { replaceCatalog(JSON.parse(value)); return true; } catch { return false; }
    }
    const deleteSnapshot = key => sql.run`DELETE FROM bookmark_snapshots WHERE snapshot_key = ${key}`.changes > 0;
    return { catalog, upsertBookmarkEntry, patchBookmarkEntry, removeBookmarkEntry,
        replaceTags, mergeTags, compatibilityForTargets,
        projectDatabaseCompatibility, projectSnapshotDatabaseCompatibility, pruneInvalid,
        pruneChatMessages, stripDatabaseCompatibility, needsLegacyMigration,
        migrateLegacyDatabase, replaceDatabaseCompatibility, saveSnapshot, saveCatalogSnapshot, restoreSnapshot,
        deleteSnapshot };
}

module.exports = { createBookmarkStore, normalizePreview, normalizeTagIds,
    stripChatCompatibility };

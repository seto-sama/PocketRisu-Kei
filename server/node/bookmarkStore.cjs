'use strict';

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
    const q = {
        getMeta: db.prepare('SELECT value FROM bookmark_meta WHERE key = ?'),
        setMeta: db.prepare(`INSERT INTO bookmark_meta(key,value) VALUES (?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
        tags: db.prepare('SELECT id,name FROM bookmark_tags ORDER BY sort_order,rowid'),
        all: db.prepare(`SELECT character_id characterId,chat_id chatId,message_id messageId,
            custom_name customName,preview,sort_order sortOrder FROM bookmarks ORDER BY rowid`),
        chat: db.prepare(`SELECT character_id characterId,chat_id chatId,message_id messageId,
            custom_name customName,preview,sort_order sortOrder FROM bookmarks
            WHERE character_id=? AND chat_id=? ORDER BY sort_order,rowid`),
        bindings: db.prepare(`SELECT character_id characterId,chat_id chatId,
            message_id messageId,tag_id tagId FROM bookmark_tag_bindings ORDER BY rowid`),
        chatBindings: db.prepare(`SELECT character_id characterId,chat_id chatId,
            message_id messageId,tag_id tagId FROM bookmark_tag_bindings
            WHERE character_id=? AND chat_id=? ORDER BY rowid`),
        get: db.prepare(`SELECT character_id characterId,chat_id chatId,message_id messageId,
            custom_name customName,preview,sort_order sortOrder FROM bookmarks
            WHERE character_id=? AND chat_id=? AND message_id=?`),
        next: db.prepare('SELECT COALESCE(MAX(sort_order)+1,0) value FROM bookmarks'),
        put: db.prepare(`INSERT INTO bookmarks(character_id,chat_id,message_id,sort_order,custom_name,preview)
            VALUES (?,?,?,?,?,?) ON CONFLICT(character_id,chat_id,message_id) DO UPDATE SET
            sort_order=excluded.sort_order,custom_name=excluded.custom_name,preview=excluded.preview`),
        del: db.prepare('DELETE FROM bookmarks WHERE character_id=? AND chat_id=? AND message_id=?'),
        delChat: db.prepare('DELETE FROM bookmarks WHERE character_id=? AND chat_id=?'),
        clear: db.prepare('DELETE FROM bookmarks'),
        bind: db.prepare(`INSERT OR IGNORE INTO bookmark_tag_bindings
            (character_id,chat_id,message_id,tag_id) VALUES (?,?,?,?)`),
        delBindings: db.prepare(`DELETE FROM bookmark_tag_bindings
            WHERE character_id=? AND chat_id=? AND message_id=?`),
        delChatBindings: db.prepare(`DELETE FROM bookmark_tag_bindings
            WHERE character_id=? AND chat_id=?`),
        clearBindings: db.prepare('DELETE FROM bookmark_tag_bindings'),
        hasTag: db.prepare('SELECT 1 FROM bookmark_tags WHERE id=?'),
        putTag: db.prepare(`INSERT INTO bookmark_tags(id,name,sort_order) VALUES (?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,sort_order=excluded.sort_order`),
        insertTag: db.prepare('INSERT INTO bookmark_tags(id,name,sort_order) VALUES (?,?,?)'),
        delTag: db.prepare('DELETE FROM bookmark_tags WHERE id=?'),
        delTagBindings: db.prepare('DELETE FROM bookmark_tag_bindings WHERE tag_id=?'),
        clearTags: db.prepare('DELETE FROM bookmark_tags'),
        saveSnapshot: db.prepare(`INSERT INTO bookmark_snapshots(snapshot_key,catalog_json)
            VALUES (?,?) ON CONFLICT(snapshot_key) DO UPDATE SET catalog_json=excluded.catalog_json`),
        snapshot: db.prepare('SELECT catalog_json catalogJson FROM bookmark_snapshots WHERE snapshot_key=?'),
        delSnapshot: db.prepare('DELETE FROM bookmark_snapshots WHERE snapshot_key=?'),
    };
    const key = row => `${row.characterId}\0${row.chatId}\0${row.messageId}`;
    const revision = () => Number(q.getMeta.get('revision')?.value ?? 0) || 0;
    const bump = () => q.setMeta.run('revision', String(revision() + 1));
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
    const validTagIds = ids => normalizeTagIds(ids).filter(id => q.hasTag.get(id));
    function withTags(rows, bindings) {
        const map = new Map(rows.map(row => [key(row), row]));
        rows.forEach(row => { row.tagIds = []; });
        bindings.forEach(binding => map.get(key(binding))?.tagIds.push(binding.tagId));
        return rows;
    }
    const chatRows = (characterId, chatId) =>
        withTags(q.chat.all(characterId, chatId), q.chatBindings.all(characterId, chatId));
    function catalog() {
        return {
            revision: revision(),
            tags: q.tags.all(),
            entries: withTags(q.all.all(), q.bindings.all()).map(row => ({
                ...row, name: row.customName || row.preview || row.messageId,
            })),
        };
    }
    function replaceBindings(entry, ids) {
        q.delBindings.run(entry.characterId, entry.chatId, entry.messageId);
        validTagIds(ids).forEach(id =>
            q.bind.run(entry.characterId, entry.chatId, entry.messageId, id));
    }
    const replaceChatTx = db.transaction((characterId, chatId, rows) => {
        const normalized = rows.map((row, index) => ({
            messageId: row.messageId, customName: row.customName ?? null,
            preview: normalizePreview(row.preview, row.messageId), sortOrder: index,
            tagIds: validTagIds(row.tagIds),
        }));
        const current = chatRows(characterId, chatId)
            .map(({ characterId: _c, chatId: _h, ...row }) => row);
        if (JSON.stringify(current) === JSON.stringify(normalized)) return false;
        q.delChatBindings.run(characterId, chatId);
        q.delChat.run(characterId, chatId);
        normalized.forEach(row => {
            q.put.run(characterId, chatId, row.messageId, row.sortOrder, row.customName, row.preview);
            replaceBindings({ characterId, chatId, messageId: row.messageId }, row.tagIds);
        });
        bump();
        return true;
    });
    const replaceChatCompatibility = (characterId, chatId, rows) =>
        Boolean(characterId && chatId && Array.isArray(rows)
            && replaceChatTx(characterId, chatId, rows));
    const upsertTx = db.transaction(entry => {
        const current = q.get.get(entry.characterId, entry.chatId, entry.messageId);
        q.put.run(entry.characterId, entry.chatId, entry.messageId,
            current?.sortOrder ?? q.next.get().value, entry.name || null,
            normalizePreview(entry.preview, entry.messageId));
        replaceBindings(entry, entry.tagIds);
        bump();
    });
    function upsertBookmarkEntry(entry) {
        if (!entry?.characterId || !entry.chatId || !entry.messageId) return false;
        upsertTx(entry); return true;
    }
    const patchTx = db.transaction((target, patch) => {
        const row = q.get.get(target.characterId, target.chatId, target.messageId);
        if (!row) return false;
        q.put.run(row.characterId, row.chatId, row.messageId, row.sortOrder,
            Object.hasOwn(patch, 'name') ? patch.name || null : row.customName, row.preview);
        if (Object.hasOwn(patch, 'tagIds')) replaceBindings(row, patch.tagIds);
        bump(); return true;
    });
    const patchBookmarkEntry = (target, patch) => patchTx(target, patch ?? {});
    const removeTx = db.transaction(target => {
        q.delBindings.run(target.characterId, target.chatId, target.messageId);
        const changed = q.del.run(target.characterId, target.chatId, target.messageId).changes > 0;
        if (changed) bump();
        return changed;
    });
    const removeBookmarkEntry = target => Boolean(target?.characterId && target.chatId
        && target.messageId && removeTx(target));
    const replaceTagsTx = db.transaction(tags => {
        const current = q.tags.all();
        if (JSON.stringify(current) === JSON.stringify(tags)) return false;
        const ids = new Set(tags.map(tag => tag.id));
        current.filter(tag => !ids.has(tag.id)).forEach(tag => {
            q.delTagBindings.run(tag.id); q.delTag.run(tag.id);
        });
        tags.forEach((tag, index) => q.putTag.run(tag.id, tag.name, index));
        bump(); return true;
    });
    function replaceTags(tags) {
        const normalized = normalizeTags(tags);
        replaceTagsTx(normalized);
        return normalized;
    }
    const mergeTagsTx = db.transaction(incoming => {
        const existing = q.tags.all();
        const byId = new Map(existing.map(tag => [tag.id, tag]));
        const idMap = {};
        let order = existing.length;
        let changed = false;
        normalizeTags(incoming).forEach(tag => {
            let id = tag.id;
            if (byId.has(id) && byId.get(id).name !== tag.name) {
                do { id = randomUUID(); } while (byId.has(id));
            }
            if (!byId.has(id)) {
                q.insertTag.run(id, tag.name, order++);
                byId.set(id, { id, name: tag.name });
                changed = true;
            }
            idMap[tag.id] = id;
        });
        if (changed) bump();
        return idMap;
    });
    const mergeTags = tags => mergeTagsTx(tags);
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
        return { entries, tags: q.tags.all().filter(tag => used.has(tag.id)) };
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
        const value = q.snapshot.get(snapshotKey)?.catalogJson;
        if (!value) return false;
        try { projectCatalogCompatibility(database, JSON.parse(value)); return true; }
        catch { return false; }
    }
    const pruneTx = db.transaction(isValid => {
        let removed = 0;
        q.all.all().forEach(row => {
            if (isValid(row)) return;
            q.delBindings.run(row.characterId, row.chatId, row.messageId);
            removed += q.del.run(row.characterId, row.chatId, row.messageId).changes;
        });
        if (removed) bump();
        return removed;
    });
    const pruneInvalid = fn => typeof fn === 'function' ? pruneTx(fn) : 0;
    const pruneChatTx = db.transaction((characterId, chatId, ids) => {
        let removed = 0;
        chatRows(characterId, chatId).forEach(row => {
            if (ids.has(row.messageId)) return;
            q.delBindings.run(characterId, chatId, row.messageId);
            removed += q.del.run(characterId, chatId, row.messageId).changes;
        });
        if (removed) bump();
        return removed;
    });
    const pruneChatMessages = (characterId, chatId, ids) =>
        characterId && chatId && ids instanceof Set ? pruneChatTx(characterId, chatId, ids) : 0;
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
        if (replaceExisting) {
            q.clearBindings.run(); q.clear.run(); q.clearTags.run();
        }
        if (includeTagData && (replaceExisting || !q.tags.all().length)) {
            normalizeTags(database?.bookmarkTags).forEach((tag, i) => q.putTag.run(tag.id, tag.name, i));
        }
        let importedChats = 0;
        (Array.isArray(database?.characters) ? database.characters : []).forEach(character =>
            (Array.isArray(character?.chats) ? character.chats : []).forEach(chat => {
                const rows = readChatCompatibility(chat, { includeTagData });
                if (!character?.chaId || !chat?.id || !rows) return;
                q.delChatBindings.run(character.chaId, chat.id);
                q.delChat.run(character.chaId, chat.id);
                rows.forEach((row, i) => {
                    const entry = { characterId: character.chaId, chatId: chat.id, messageId: row.messageId };
                    q.put.run(entry.characterId, entry.chatId, entry.messageId, i, row.customName, row.preview);
                    replaceBindings(entry, row.tagIds);
                });
                importedChats++;
            }));
        return importedChats;
    }
    const migrateTx = db.transaction(database => {
        const complete = q.getMeta.get(LEGACY_MIGRATION_KEY)?.value === '1';
        if (!complete) {
            ingest(database);
            q.setMeta.run(LEGACY_MIGRATION_KEY, '1');
            bump();
        }
        return { changed: stripDatabaseCompatibility(database), migrated: !complete };
    });
    const migrateLegacyDatabase = database => migrateTx(database);
    const needsLegacyMigration = () => q.getMeta.get(LEGACY_MIGRATION_KEY)?.value !== '1';
    const replaceDatabaseTx = db.transaction(database => {
        const importedChats = ingest(database, { replaceExisting: true, includeTagData: true });
        q.setMeta.run(LEGACY_MIGRATION_KEY, '1'); bump();
        return { changed: stripDatabaseCompatibility(database), migrated: true, importedChats };
    });
    const replaceDatabaseCompatibility = database => replaceDatabaseTx(database);
    const replaceCatalogTx = db.transaction(value => {
        q.clearBindings.run(); q.clear.run(); q.clearTags.run();
        normalizeTags(value?.tags).forEach((tag, i) => q.insertTag.run(tag.id, tag.name, i));
        (Array.isArray(value?.entries) ? value.entries : []).forEach((row, i) => {
            if (!row?.characterId || !row.chatId || !row.messageId) return;
            q.put.run(row.characterId, row.chatId, row.messageId,
                Number.isFinite(row.sortOrder) ? row.sortOrder : i,
                typeof row.customName === 'string' && row.customName ? row.customName : null,
                normalizePreview(row.preview, row.messageId));
            replaceBindings(row, row.tagIds);
        });
        bump();
    });
    function saveSnapshot(key) {
        if (typeof key !== 'string' || !key || needsLegacyMigration()) return false;
        q.saveSnapshot.run(key, JSON.stringify(catalog())); return true;
    }
    function restoreSnapshot(key) {
        const value = q.snapshot.get(key)?.catalogJson;
        if (!value) return false;
        try { replaceCatalogTx(JSON.parse(value)); return true; } catch { return false; }
    }
    const deleteSnapshot = key => q.delSnapshot.run(key).changes > 0;
    return { catalog, upsertBookmarkEntry, patchBookmarkEntry, removeBookmarkEntry,
        replaceChatCompatibility, replaceTags, mergeTags, compatibilityForTargets,
        projectDatabaseCompatibility, projectSnapshotDatabaseCompatibility, pruneInvalid,
        pruneChatMessages, stripDatabaseCompatibility, needsLegacyMigration,
        migrateLegacyDatabase, replaceDatabaseCompatibility, saveSnapshot, restoreSnapshot,
        deleteSnapshot };
}

module.exports = { createBookmarkStore, normalizePreview, normalizeTagIds,
    readChatCompatibility, stripChatCompatibility };

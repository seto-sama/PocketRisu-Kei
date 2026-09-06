'use strict';

const crypto = require('crypto');
const { createContentReferenceCollector, validateReferenceCandidates, matchContentReferences } = require('../../shared/contentReferences.mjs');
const { Packr, Unpackr } = require('msgpackr');
const { normalizeJSON } = require('./utils.cjs');
const {
    chatToStub,
    computeChatEtag,
    mergeChatStubWithFullChat,
} = require('./chatStore.cjs');
const { characterToPersistentShape } = require('./persistenceShape.cjs');
const {
    classifiedPluginOwner,
    installedV3Plugins,
} = require('./pluginStorageProjection.cjs');

const APP_DATA_SCHEMA_VERSION = 1;
const STATE_ROW_ID = 1;
const MISSING_CHAT_ETAG = 'missing';

const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false });

// Large, independently edited root collections have their own physical rows.
// Everything else remains a key-addressable root setting. Keeping the mapping
// here makes the compatibility projection lossless without teaching callers
// about the SQL layout.
const PRESET_FIELDS = new Map([
    ['botPresets', 'bot'],
    ['themePresets', 'theme'],
    ['togglePresets', 'toggle'],
    ['imageGenerationPresets', 'image-generation'],
    ['imageStylePresets', 'image-style'],
    ['translatorPresets', 'translator'],
    ['hypaV3Presets', 'hypa-v3'],
    ['modelPresets', 'model'],
]);

const SPECIAL_ROOT_FIELDS = new Map([
    ['characters', { kind: 'characters' }],
    ...Array.from(PRESET_FIELDS, ([field, collection]) => [field, {
        kind: 'presets',
        collection,
    }]),
    ['modules', { kind: 'modules' }],
    ['plugins', { kind: 'plugins', collection: 'legacy' }],
    ['pluginV2', { kind: 'plugins', collection: 'v2' }],
    ['personas', { kind: 'personas' }],
    ['pluginCustomStorage', { kind: 'plugin-storage' }],
]);

class AppDataConflictError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'AppDataConflictError';
        this.currentRevision = options.currentRevision;
        this.currentEtag = options.currentEtag;
    }
}

function encodeValue(value) {
    return Buffer.from(packr.pack(value));
}

function decodeValue(value) {
    if (value === null || value === undefined) return undefined;
    return unpackr.unpack(value);
}

function withoutKeys(value, keys) {
    const result = { ...(value ?? {}) };
    for (const key of keys) delete result[key];
    return result;
}

function normalizedProjection(value) {
    const normalized = normalizeJSON(value ?? {});
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
        throw new TypeError('Database projection must be an object');
    }
    if (!Array.isArray(normalized.characters)) normalized.characters = [];
    return normalized;
}

function uniqueKey(candidate, position, used) {
    const base = typeof candidate === 'string' && candidate.length > 0
        ? candidate
        : `@${position}`;
    let key = base;
    let suffix = 1;
    while (used.has(key)) {
        key = `${base}#${suffix++}`;
    }
    used.add(key);
    return key;
}

function persistentEntityId(candidate, used) {
    if (typeof candidate === 'string' && candidate.length > 0 && !used.has(candidate)) {
        used.add(candidate);
        return candidate;
    }
    let generated = crypto.randomUUID();
    while (used.has(generated)) generated = crypto.randomUUID();
    used.add(generated);
    return generated;
}

function collectionItemKey(item, position, used) {
    return uniqueKey(item?.id, position, used);
}

function messageItemKey(message, position, used) {
    return uniqueKey(message?.chatId ?? message?.id, position, used);
}

function chatMetadata(chat) {
    const stub = chatToStub(chat ?? {});
    if (stub && typeof stub === 'object') return stub;
    return { id: chat?.id ?? '', name: '', _stub: true };
}

// Metadata synchronization is deliberately stricter than compatibility
// import. A startup projection may contain placeholders (or, from an older
// client, an accidentally hydrated chat); neither is allowed to replace the
// independently stored chat body.
function startupChatMetadata(chat, chatId) {
    const source = withoutKeys(chat, ['message', '_stub', '_placeholder']);
    return { ...chatToStub({ ...source, id: chatId }), id: chatId };
}

function chatContent(chat) {
    // Stub/list metadata has a separate authoritative row. Never duplicate it
    // in the body payload: otherwise removing an optional stub key can expose
    // the stale body copy again during hydration.
    return withoutKeys(chat, [
        'id', 'name', 'lastDate', 'folderId', 'modules',
        'message', '_stub', '_placeholder',
    ]);
}

function characterMetadata(character) {
    return withoutKeys(characterToPersistentShape(character ?? {}), ['chaId', 'chats']);
}

function encodedEqual(left, right) {
    return encodeValue(left).equals(encodeValue(right));
}

function hashProjection(projection) {
    return crypto.createHash('sha256').update(encodeValue(projection)).digest('hex');
}

function createAppDataStore(db) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
        throw new TypeError('createAppDataStore requires a better-sqlite3 database');
    }

    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_data_state (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        revision       INTEGER NOT NULL DEFAULT 0,
        initialized    INTEGER NOT NULL DEFAULT 0,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_root_fields (
        field_key  TEXT PRIMARY KEY,
        position   INTEGER NOT NULL UNIQUE,
        field_kind TEXT NOT NULL,
        collection TEXT,
        payload    BLOB,
        revision   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_presets (
        collection TEXT NOT NULL,
        item_key    TEXT NOT NULL,
        position    INTEGER NOT NULL,
        payload     BLOB NOT NULL,
        revision    INTEGER NOT NULL,
        PRIMARY KEY (collection, item_key),
        UNIQUE (collection, position)
      );

      CREATE TABLE IF NOT EXISTS app_modules (
        item_key  TEXT PRIMARY KEY,
        position  INTEGER NOT NULL UNIQUE,
        payload   BLOB NOT NULL,
        revision  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_plugins (
        collection TEXT NOT NULL,
        item_key    TEXT NOT NULL,
        position    INTEGER NOT NULL,
        payload     BLOB NOT NULL,
        revision    INTEGER NOT NULL,
        PRIMARY KEY (collection, item_key),
        UNIQUE (collection, position)
      );

      CREATE TABLE IF NOT EXISTS app_personas (
        item_key  TEXT PRIMARY KEY,
        position  INTEGER NOT NULL UNIQUE,
        payload   BLOB NOT NULL,
        revision  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_plugin_storage (
        storage_key TEXT PRIMARY KEY,
        payload     BLOB NOT NULL,
        revision    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_characters (
        character_id TEXT PRIMARY KEY,
        position     INTEGER NOT NULL UNIQUE,
        payload      BLOB NOT NULL,
        revision     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_chats (
        character_id   TEXT NOT NULL,
        chat_id        TEXT NOT NULL,
        position       INTEGER NOT NULL,
        stub_payload   BLOB NOT NULL,
        content_payload BLOB NOT NULL,
        content_etag   TEXT NOT NULL,
        revision       INTEGER NOT NULL,
        PRIMARY KEY (character_id, chat_id),
        UNIQUE (character_id, position),
        FOREIGN KEY (character_id) REFERENCES app_characters(character_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_messages (
        character_id TEXT NOT NULL,
        chat_id      TEXT NOT NULL,
        message_key  TEXT NOT NULL,
        position     INTEGER NOT NULL,
        payload      BLOB NOT NULL,
        revision     INTEGER NOT NULL,
        PRIMARY KEY (character_id, chat_id, message_key),
        UNIQUE (character_id, chat_id, position),
        FOREIGN KEY (character_id, chat_id)
          REFERENCES app_chats(character_id, chat_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS app_chats_character_order
        ON app_chats(character_id, position);
      CREATE INDEX IF NOT EXISTS app_messages_chat_order
        ON app_messages(character_id, chat_id, position);
    `);

    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO app_data_state
        (id, schema_version, revision, initialized, updated_at)
      VALUES (?, ?, 0, 0, ?)
    `).run(STATE_ROW_ID, APP_DATA_SCHEMA_VERSION, now);

    const stateRow = db.prepare(`
      SELECT schema_version, revision, initialized, updated_at
      FROM app_data_state WHERE id = ?
    `);
    const updateState = db.prepare(`
      UPDATE app_data_state
      SET revision = ?, initialized = ?, updated_at = ?
      WHERE id = ?
    `);

    const installedState = stateRow.get(STATE_ROW_ID);
    if (installedState.schema_version !== APP_DATA_SCHEMA_VERSION) {
        throw new Error(
            `Unsupported app data schema ${installedState.schema_version}; `
            + `expected ${APP_DATA_SCHEMA_VERSION}`,
        );
    }

    const insertRootField = db.prepare(`
      INSERT INTO app_root_fields
        (field_key, position, field_kind, collection, payload, revision)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertPreset = db.prepare(`
      INSERT INTO app_presets (collection, item_key, position, payload, revision)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertModule = db.prepare(`
      INSERT INTO app_modules (item_key, position, payload, revision)
      VALUES (?, ?, ?, ?)
    `);
    const insertPlugin = db.prepare(`
      INSERT INTO app_plugins (collection, item_key, position, payload, revision)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertPersona = db.prepare(`
      INSERT INTO app_personas (item_key, position, payload, revision)
      VALUES (?, ?, ?, ?)
    `);
    const insertPluginStorage = db.prepare(`
      INSERT INTO app_plugin_storage (storage_key, payload, revision)
      VALUES (?, ?, ?)
    `);
    const insertCharacter = db.prepare(`
      INSERT INTO app_characters (character_id, position, payload, revision)
      VALUES (?, ?, ?, ?)
    `);
    const insertChat = db.prepare(`
      INSERT INTO app_chats
        (character_id, chat_id, position, stub_payload, content_payload, content_etag, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMessage = db.prepare(`
      INSERT INTO app_messages
        (character_id, chat_id, message_key, position, payload, revision)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const deleteAllProjectionRows = db.transaction(() => {
        // Parent deletes cascade through chats and messages. The remaining
        // tables are independent projections of root domains.
        db.prepare('DELETE FROM app_characters').run();
        db.prepare('DELETE FROM app_root_fields').run();
        db.prepare('DELETE FROM app_presets').run();
        db.prepare('DELETE FROM app_modules').run();
        db.prepare('DELETE FROM app_plugins').run();
        db.prepare('DELETE FROM app_personas').run();
        db.prepare('DELETE FROM app_plugin_storage').run();
    });

    function getState() {
        const row = stateRow.get(STATE_ROW_ID);
        return {
            schemaVersion: row.schema_version,
            revision: row.revision,
            initialized: row.initialized === 1,
            updatedAt: row.updated_at,
        };
    }

    function assertExpectedRevision(expectedRevision) {
        const state = getState();
        if (expectedRevision !== undefined && expectedRevision !== state.revision) {
            throw new AppDataConflictError('Database revision changed', {
                currentRevision: state.revision,
            });
        }
        return state;
    }

    function insertCollectionRows(tableKind, collection, value, revision) {
        const items = Array.isArray(value) ? value : [];
        const used = new Set();
        for (let position = 0; position < items.length; position++) {
            const item = items[position];
            const key = collectionItemKey(item, position, used);
            switch (tableKind) {
                case 'presets':
                    insertPreset.run(collection, key, position, encodeValue(item), revision);
                    break;
                case 'modules':
                    insertModule.run(key, position, encodeValue(item), revision);
                    break;
                case 'plugins':
                    insertPlugin.run(collection, key, position, encodeValue(item), revision);
                    break;
                case 'personas':
                    insertPersona.run(key, position, encodeValue(item), revision);
                    break;
                default:
                    throw new Error(`Unknown collection table kind: ${tableKind}`);
            }
        }
    }

    function insertPluginStorageRows(value, revision) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        for (const key of Object.keys(value)) {
            insertPluginStorage.run(key, encodeValue(value[key]), revision);
        }
    }

    function insertCharacterRows(characters, revision) {
        const usedCharacters = new Set();
        for (let position = 0; position < characters.length; position++) {
            const character = characters[position] ?? {};
            const characterId = persistentEntityId(character.chaId, usedCharacters);
            insertCharacter.run(
                characterId,
                position,
                encodeValue(characterMetadata(character)),
                revision,
            );

            const usedChats = new Set();
            const chats = Array.isArray(character.chats) ? character.chats : [];
            for (let chatPosition = 0; chatPosition < chats.length; chatPosition++) {
                const chat = chats[chatPosition] ?? {};
                const chatId = persistentEntityId(chat.id, usedChats);
                const fullChat = {
                    ...chatContent(chat),
                    id: chatId,
                    message: Array.isArray(chat.message) ? chat.message : [],
                };
                const stub = { ...chatMetadata({ ...chat, id: chatId }), id: chatId };
                const canonicalChat = mergeChatStubWithFullChat(stub, fullChat);
                insertChat.run(
                    characterId,
                    chatId,
                    chatPosition,
                    encodeValue(stub),
                    encodeValue(chatContent(fullChat)),
                    computeChatEtag(canonicalChat),
                    revision,
                );

                const usedMessages = new Set();
                for (let messagePosition = 0; messagePosition < fullChat.message.length; messagePosition++) {
                    const message = fullChat.message[messagePosition];
                    insertMessage.run(
                        characterId,
                        chatId,
                        messageItemKey(message, messagePosition, usedMessages),
                        messagePosition,
                        encodeValue(message),
                        revision,
                    );
                }
            }
        }
    }

    const replaceTransaction = db.transaction((projection, expectedRevision) => {
        const state = assertExpectedRevision(expectedRevision);
        const revision = state.revision + 1;
        deleteAllProjectionRows();

        const keys = Object.keys(projection);
        if (!keys.includes('characters')) keys.unshift('characters');
        for (let position = 0; position < keys.length; position++) {
            const field = keys[position];
            const special = SPECIAL_ROOT_FIELDS.get(field);
            if (!special) {
                insertRootField.run(
                    field,
                    position,
                    'value',
                    null,
                    encodeValue(projection[field]),
                    revision,
                );
                continue;
            }

            insertRootField.run(
                field,
                position,
                special.kind,
                special.collection ?? null,
                null,
                revision,
            );
            if (special.kind === 'characters') {
                insertCharacterRows(projection.characters, revision);
            } else if (special.kind === 'plugin-storage') {
                insertPluginStorageRows(projection[field], revision);
            } else {
                insertCollectionRows(
                    special.kind,
                    special.collection ?? null,
                    projection[field],
                    revision,
                );
            }
        }

        const updatedAt = Date.now();
        updateState.run(revision, 1, updatedAt, STATE_ROW_ID);
        return { revision, updatedAt };
    });

    function replaceFromProjection(value, options = {}) {
        const projection = normalizedProjection(value);
        return replaceTransaction(projection, options.expectedRevision);
    }

    const selectRootFields = db.prepare(`
      SELECT field_key, field_kind, collection, payload
      FROM app_root_fields ORDER BY position
    `);
    const selectPresets = db.prepare(`
      SELECT payload FROM app_presets WHERE collection = ? ORDER BY position
    `);
    const selectModules = db.prepare('SELECT payload FROM app_modules ORDER BY position');
    const selectPlugins = db.prepare(`
      SELECT payload FROM app_plugins WHERE collection = ? ORDER BY position
    `);
    const selectPersonas = db.prepare('SELECT payload FROM app_personas ORDER BY position');
    const selectPluginStorage = db.prepare(`
      SELECT storage_key, payload FROM app_plugin_storage ORDER BY rowid
    `);
    const selectPluginStorageSizes = db.prepare(`
      SELECT storage_key, LENGTH(payload) AS bytes
      FROM app_plugin_storage ORDER BY rowid
    `);
    const selectRootValue = db.prepare(`
      SELECT payload FROM app_root_fields WHERE field_key = ?
    `);
    const selectCharacters = db.prepare(`
      SELECT character_id, payload FROM app_characters ORDER BY position
    `);
    const selectChats = db.prepare(`
      SELECT chat_id, stub_payload, content_payload, content_etag
      FROM app_chats WHERE character_id = ? ORDER BY position
    `);
    const selectMessages = db.prepare(`
      SELECT payload FROM app_messages
      WHERE character_id = ? AND chat_id = ? ORDER BY position
    `);
    const selectProjectionPayloadBytes = db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM app_root_fields)
        + (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM app_presets)
        + (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM app_modules)
        + (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM app_plugins)
        + (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM app_personas)
        + (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM app_plugin_storage)
        + (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM app_characters)
        + (SELECT COALESCE(SUM(LENGTH(stub_payload) + LENGTH(content_payload)), 0)
             FROM app_chats)
        + (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM app_messages)
        AS payload_bytes
    `);
    const selectCharacterStorage = db.prepare(`
      SELECT
        character_id,
        payload,
        LENGTH(payload) AS card_bytes,
        COALESCE((
          SELECT SUM(LENGTH(chat.stub_payload) + LENGTH(chat.content_payload))
          FROM app_chats AS chat
          WHERE chat.character_id = character.character_id
        ), 0) + COALESCE((
          SELECT SUM(LENGTH(message.payload))
          FROM app_messages AS message
          WHERE message.character_id = character.character_id
        ), 0) AS chat_bytes
      FROM app_characters AS character
      ORDER BY position
    `);
    const selectModuleStorage = db.prepare(`
      SELECT payload, LENGTH(payload) AS body_bytes
      FROM app_modules ORDER BY position
    `);

    function readCollection(kind, collection) {
        let rows;
        switch (kind) {
            case 'presets': rows = selectPresets.all(collection); break;
            case 'modules': rows = selectModules.all(); break;
            case 'plugins': rows = selectPlugins.all(collection); break;
            case 'personas': rows = selectPersonas.all(); break;
            default: throw new Error(`Unknown collection kind: ${kind}`);
        }
        return rows.map(row => decodeValue(row.payload));
    }

    function readPluginStorage() {
        const result = {};
        for (const row of selectPluginStorage.all()) {
            Object.defineProperty(result, row.storage_key, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: decodeValue(row.payload),
            });
        }
        return result;
    }

    /**
     * Lightweight startup guard data. Values are never decoded here: only the
     * per-key SQLite payload lengths and the small ownership/plugin manifests
     * are read, so the browser can decide before requesting the full DB.
     */
    function pluginStorageFootprint() {
        const ownerRow = selectRootValue.get('pluginStorageMeta');
        const ownerMeta = decodeValue(ownerRow?.payload) ?? {};
        const installedPlugins = selectPlugins.all('legacy')
            .map(row => decodeValue(row.payload));
        const v3Plugins = installedV3Plugins(installedPlugins);
        const bytesByPlugin = new Map(
            Array.from(v3Plugins.keys(), name => [name, 0]),
        );
        let totalBytes = 0;
        let unclassifiedBytes = 0;
        for (const row of selectPluginStorageSizes.all()) {
            const bytes = Number(row.bytes ?? 0);
            totalBytes += bytes;
            const owner = classifiedPluginOwner(ownerMeta, row.storage_key, v3Plugins);
            if (owner !== null) {
                bytesByPlugin.set(owner, (bytesByPlugin.get(owner) ?? 0) + bytes);
            } else {
                unclassifiedBytes += bytes;
            }
        }
        return {
            totalBytes,
            unclassifiedBytes,
            plugins: Array.from(v3Plugins, ([name, plugin]) => ({
                name,
                displayName: typeof plugin.displayName === 'string'
                    ? plugin.displayName
                    : name,
                bytes: bytesByPlugin.get(name) ?? 0,
            })).sort((a, b) => b.bytes - a.bytes || a.displayName.localeCompare(b.displayName)),
        };
    }

    function readMessages(characterId, chatId) {
        return selectMessages.all(characterId, chatId)
            .map(row => decodeValue(row.payload));
    }

    function assembleChat(row, characterId, includeMessages) {
        const stub = decodeValue(row.stub_payload);
        if (!includeMessages) return stub;
        const content = {
            // Also sanitize rows created by pre-fix builds so stale duplicate
            // metadata cannot reappear before that row is next rewritten.
            ...chatContent(decodeValue(row.content_payload)),
            id: row.chat_id,
            message: readMessages(characterId, row.chat_id),
        };
        return mergeChatStubWithFullChat(stub, content);
    }

    function readCharacters(includeMessages) {
        return selectCharacters.all().map(row => ({
            ...decodeValue(row.payload),
            chaId: row.character_id,
            chats: selectChats.all(row.character_id)
                .map(chat => assembleChat(chat, row.character_id, includeMessages)),
        }));
    }

    function exportProjection(options = {}) {
        const includeMessages = options.includeMessages !== false;
        const result = {};
        for (const row of selectRootFields.all()) {
            switch (row.field_kind) {
                case 'value':
                    result[row.field_key] = decodeValue(row.payload);
                    break;
                case 'characters':
                    result[row.field_key] = readCharacters(includeMessages);
                    break;
                case 'plugin-storage':
                    result[row.field_key] = readPluginStorage();
                    break;
                case 'presets':
                case 'modules':
                case 'plugins':
                case 'personas':
                    result[row.field_key] = readCollection(row.field_kind, row.collection);
                    break;
                default:
                    throw new Error(`Unknown root field kind: ${row.field_kind}`);
            }
        }
        if (!Object.hasOwn(result, 'characters')) result.characters = [];
        return result;
    }

    // A consistent server snapshot, decoding one chat at a time. Only the
    // caller-owned candidates receive usage flags; no text or ids leave the server.
    const scanContentReferences = db.transaction((kind, candidates) => {
        validateReferenceCandidates(kind, candidates);
        const collector = createContentReferenceCollector(kind);
        for (const row of selectCharacters.iterate()) {
            collector.addCharacter(decodeValue(row.payload));
            for (const chat of selectChats.iterate(row.character_id)) {
                collector.addChat(assembleChat(chat, row.character_id, true));
            }
        }
        return matchContentReferences(collector.result(), candidates);
    });

    function estimateProjectionBytes() {
        return Number(selectProjectionPayloadBytes.get()?.payload_bytes ?? 0);
    }

    function listCharacterStorage() {
        return selectCharacterStorage.all().map(row => ({
            character: { ...decodeValue(row.payload), chaId: row.character_id },
            cardBytes: Number(row.card_bytes ?? 0),
            chatBytes: Number(row.chat_bytes ?? 0),
        }));
    }

    function listModuleStorage() {
        return selectModuleStorage.all().map(row => ({
            module: decodeValue(row.payload),
            bodyBytes: Number(row.body_bytes ?? 0),
        }));
    }

    function canonicalStartupProjection(value) {
        const projection = normalizedProjection(value);
        const result = {};
        for (const field of Object.keys(projection)) {
            if (field !== 'characters') {
                result[field] = projection[field];
                continue;
            }

            const usedCharacters = new Set();
            result.characters = projection.characters.map(character => {
                const characterId = persistentEntityId(
                    character?.chaId,
                    usedCharacters,
                );
                const usedChats = new Set();
                const chats = Array.isArray(character?.chats) ? character.chats : [];
                return {
                    ...characterMetadata(character),
                    chaId: characterId,
                    chats: chats.map(chat => {
                        const chatId = persistentEntityId(chat?.id, usedChats);
                        return startupChatMetadata(chat, chatId);
                    }),
                };
            });
        }
        return result;
    }

    const selectSyncRootFields = db.prepare(`
      SELECT field_key, position, field_kind, collection, payload, revision
      FROM app_root_fields ORDER BY position
    `);
    const temporizeRootPositions = db.prepare(`
      UPDATE app_root_fields SET position = -position - 1
    `);
    const deleteRootField = db.prepare(`
      DELETE FROM app_root_fields WHERE field_key = ?
    `);
    const updateRootField = db.prepare(`
      UPDATE app_root_fields
      SET position = ?, field_kind = ?, collection = ?, payload = ?, revision = ?
      WHERE field_key = ?
    `);

    const deletePresetCollection = db.prepare(`
      DELETE FROM app_presets WHERE collection = ?
    `);
    const deleteModules = db.prepare('DELETE FROM app_modules');
    const deletePluginCollection = db.prepare(`
      DELETE FROM app_plugins WHERE collection = ?
    `);
    const deletePersonas = db.prepare('DELETE FROM app_personas');
    const deletePluginStorage = db.prepare('DELETE FROM app_plugin_storage');

    const selectSyncCharacters = db.prepare(`
      SELECT character_id, position, payload, revision
      FROM app_characters ORDER BY position
    `);
    const temporizeCharacterPositions = db.prepare(`
      UPDATE app_characters SET position = -position - 1
    `);
    const deleteCharacter = db.prepare(`
      DELETE FROM app_characters WHERE character_id = ?
    `);
    const updateCharacter = db.prepare(`
      UPDATE app_characters SET position = ?, payload = ?, revision = ?
      WHERE character_id = ?
    `);
    const selectSyncChats = db.prepare(`
      SELECT chat_id, position, stub_payload, content_payload, content_etag, revision
      FROM app_chats WHERE character_id = ? ORDER BY position
    `);
    const temporizeChatPositions = db.prepare(`
      UPDATE app_chats SET position = -position - 1 WHERE character_id = ?
    `);
    const deleteSyncChat = db.prepare(`
      DELETE FROM app_chats WHERE character_id = ? AND chat_id = ?
    `);
    const updateChatMetadata = db.prepare(`
      UPDATE app_chats
      SET position = ?, stub_payload = ?, content_payload = ?,
          content_etag = ?, revision = ?
      WHERE character_id = ? AND chat_id = ?
    `);

    function clearSpecialRows(special) {
        switch (special.kind) {
            case 'characters':
                db.prepare('DELETE FROM app_characters').run();
                break;
            case 'presets':
                deletePresetCollection.run(special.collection);
                break;
            case 'modules':
                deleteModules.run();
                break;
            case 'plugins':
                deletePluginCollection.run(special.collection);
                break;
            case 'personas':
                deletePersonas.run();
                break;
            case 'plugin-storage':
                deletePluginStorage.run();
                break;
            default:
                throw new Error(`Unknown root field kind: ${special.kind}`);
        }
    }

    function replaceSpecialRows(special, value, revision) {
        clearSpecialRows(special);
        if (special.kind === 'plugin-storage') {
            insertPluginStorageRows(value, revision);
        } else {
            insertCollectionRows(
                special.kind,
                special.collection ?? null,
                value,
                revision,
            );
        }
    }

    function sameOrderedIds(currentRows, desiredItems, currentKey, desiredKey) {
        return currentRows.length === desiredItems.length
            && currentRows.every((row, index) => (
                currentKey(row) === desiredKey(desiredItems[index])
            ));
    }

    function syncChatRows(characterId, desiredChats, revision) {
        const currentRows = selectSyncChats.all(characterId);
        const currentById = new Map(currentRows.map(row => [row.chat_id, row]));
        const desiredIds = new Set(desiredChats.map(chat => chat.id));
        const orderChanged = !sameOrderedIds(
            currentRows,
            desiredChats,
            row => row.chat_id,
            chat => chat.id,
        );

        if (orderChanged && currentRows.length > 0) {
            temporizeChatPositions.run(characterId);
        }
        for (const row of currentRows) {
            if (!desiredIds.has(row.chat_id)) {
                deleteSyncChat.run(characterId, row.chat_id);
            }
        }

        for (let position = 0; position < desiredChats.length; position++) {
            const stub = desiredChats[position];
            const currentRow = currentById.get(stub.id);
            if (!currentRow) {
                const content = { id: stub.id, message: [] };
                const canonical = mergeChatStubWithFullChat(stub, content);
                insertChat.run(
                    characterId,
                    stub.id,
                    position,
                    encodeValue(stub),
                    encodeValue(chatContent(content)),
                    computeChatEtag(canonical),
                    revision,
                );
                continue;
            }

            const stubChanged = !encodedEqual(
                decodeValue(currentRow.stub_payload),
                stub,
            );
            const positionChanged = currentRow.position !== position;
            if (!stubChanged && !positionChanged && !orderChanged) continue;

            let content = decodeValue(currentRow.content_payload);
            let etag = currentRow.content_etag;
            if (stubChanged) {
                const currentFullChat = assembleChat(currentRow, characterId, true);
                const reconciled = mergeChatStubWithFullChat(stub, currentFullChat);
                content = chatContent(reconciled);
                etag = computeChatEtag(reconciled);
            }
            updateChatMetadata.run(
                position,
                encodeValue(stub),
                encodeValue(content),
                etag,
                stubChanged || positionChanged ? revision : currentRow.revision,
                characterId,
                stub.id,
            );
        }
    }

    function syncCharacterRows(desiredCharacters, revision) {
        const currentRows = selectSyncCharacters.all();
        const currentById = new Map(currentRows.map(row => [row.character_id, row]));
        const desiredIds = new Set(desiredCharacters.map(character => character.chaId));
        const orderChanged = !sameOrderedIds(
            currentRows,
            desiredCharacters,
            row => row.character_id,
            character => character.chaId,
        );

        if (orderChanged && currentRows.length > 0) temporizeCharacterPositions.run();
        for (const row of currentRows) {
            if (!desiredIds.has(row.character_id)) deleteCharacter.run(row.character_id);
        }

        for (let position = 0; position < desiredCharacters.length; position++) {
            const character = desiredCharacters[position];
            const metadata = characterMetadata(character);
            const currentRow = currentById.get(character.chaId);
            if (!currentRow) {
                insertCharacter.run(
                    character.chaId,
                    position,
                    encodeValue(metadata),
                    revision,
                );
            } else {
                const metadataChanged = !encodedEqual(
                    decodeValue(currentRow.payload),
                    metadata,
                );
                const positionChanged = currentRow.position !== position;
                if (metadataChanged || positionChanged || orderChanged) {
                    updateCharacter.run(
                        position,
                        encodeValue(metadata),
                        metadataChanged || positionChanged
                            ? revision
                            : currentRow.revision,
                        character.chaId,
                    );
                }
            }
            syncChatRows(character.chaId, character.chats, revision);
        }
    }

    const syncStartupTransaction = db.transaction((incoming, options) => {
        const state = getState();
        const current = exportProjection({ includeMessages: false });
        const currentEtag = hashProjection(current);
        if (options.expectedRevision !== undefined
            && options.expectedRevision !== state.revision) {
            throw new AppDataConflictError('Database revision changed', {
                currentRevision: state.revision,
                currentEtag,
            });
        }
        if (options.expectedEtag !== undefined
            && options.expectedEtag !== currentEtag) {
            throw new AppDataConflictError('Startup projection changed', {
                currentRevision: state.revision,
                currentEtag,
            });
        }

        const desired = canonicalStartupProjection(incoming);
        if (state.initialized && encodedEqual(current, desired)) {
            return {
                changed: false,
                revision: state.revision,
                updatedAt: state.updatedAt,
                etag: currentEtag,
            };
        }

        const revision = state.revision + 1;
        const currentKeys = Object.keys(current);
        const desiredKeys = Object.keys(desired);
        const currentKeySet = new Set(currentKeys);
        const desiredKeySet = new Set(desiredKeys);
        const changedFields = new Set();
        for (const field of new Set([...currentKeys, ...desiredKeys])) {
            if (!currentKeySet.has(field)
                || !desiredKeySet.has(field)
                || !encodedEqual(current[field], desired[field])) {
                changedFields.add(field);
            }
        }

        for (const field of changedFields) {
            const special = SPECIAL_ROOT_FIELDS.get(field);
            if (!special) continue;
            if (!desiredKeySet.has(field)) {
                clearSpecialRows(special);
            } else if (special.kind === 'characters') {
                syncCharacterRows(desired.characters, revision);
            } else {
                replaceSpecialRows(special, desired[field], revision);
            }
        }

        const rootRows = selectSyncRootFields.all();
        const rootByField = new Map(rootRows.map(row => [row.field_key, row]));
        const rootOrderChanged = !sameOrderedIds(
            rootRows,
            desiredKeys,
            row => row.field_key,
            field => field,
        );
        if (rootOrderChanged && rootRows.length > 0) temporizeRootPositions.run();
        for (const row of rootRows) {
            if (!desiredKeySet.has(row.field_key)) deleteRootField.run(row.field_key);
        }
        for (let position = 0; position < desiredKeys.length; position++) {
            const field = desiredKeys[position];
            const special = SPECIAL_ROOT_FIELDS.get(field);
            const kind = special?.kind ?? 'value';
            const collection = special?.collection ?? null;
            const payload = special ? null : encodeValue(desired[field]);
            const currentRow = rootByField.get(field);
            if (!currentRow) {
                insertRootField.run(
                    field,
                    position,
                    kind,
                    collection,
                    payload,
                    revision,
                );
                continue;
            }
            const rowChanged = changedFields.has(field)
                || currentRow.position !== position
                || currentRow.field_kind !== kind
                || currentRow.collection !== collection;
            if (rowChanged || rootOrderChanged) {
                updateRootField.run(
                    position,
                    kind,
                    collection,
                    payload,
                    rowChanged ? revision : currentRow.revision,
                    field,
                );
            }
        }

        const updatedAt = Date.now();
        updateState.run(revision, 1, updatedAt, STATE_ROW_ID);
        const etag = hashProjection(exportProjection({ includeMessages: false }));
        return { changed: true, revision, updatedAt, etag };
    });

    /**
     * Synchronize the browser's complete, stubs-only startup projection.
     * Root/character/chat metadata and ordering are authoritative here; chat
     * content and message rows remain owned by commitChat().
     */
    function syncStartupProjection(value, options = {}) {
        return syncStartupTransaction(value, {
            expectedRevision: options.expectedRevision,
            expectedEtag: options.expectedEtag ?? options.expectedProjectionEtag,
        });
    }

    const selectChat = db.prepare(`
      SELECT chat_id, stub_payload, content_payload, content_etag, position
      FROM app_chats WHERE character_id = ? AND chat_id = ?
    `);
    const selectChatStubAt = db.prepare(`
      SELECT chat_id, stub_payload
      FROM app_chats WHERE character_id = ? AND position = ?
    `);
    const characterExists = db.prepare(`
      SELECT 1 AS found FROM app_characters WHERE character_id = ?
    `);
    const nextChatPosition = db.prepare(`
      SELECT COALESCE(MAX(position) + 1, 0) AS position
      FROM app_chats WHERE character_id = ?
    `);
    const updateChatContent = db.prepare(`
      UPDATE app_chats
      SET content_payload = ?, content_etag = ?, revision = ?
      WHERE character_id = ? AND chat_id = ?
    `);
    const deleteMessages = db.prepare(`
      DELETE FROM app_messages WHERE character_id = ? AND chat_id = ?
    `);

    function getChat(characterId, chatId) {
        const row = selectChat.get(characterId, chatId);
        return row ? assembleChat(row, characterId, true) : undefined;
    }

    function getChatStubAt(characterId, position) {
        const row = selectChatStubAt.get(characterId, position);
        return row ? decodeValue(row.stub_payload) : undefined;
    }

    function hasChat(characterId, chatId) {
        return Boolean(selectChat.get(characterId, chatId));
    }

    const commitChatTransaction = db.transaction((characterId, chatId, incoming, expectedEtag, options) => {
        const state = getState();
        const currentRow = selectChat.get(characterId, chatId);
        const currentEtag = currentRow?.content_etag ?? MISSING_CHAT_ETAG;
        if ((options.requireExpected && currentRow && !expectedEtag)
            || (expectedEtag && expectedEtag !== currentEtag)) {
            throw new AppDataConflictError('Chat content changed', {
                currentRevision: state.revision,
                currentEtag,
            });
        }
        if (!characterExists.get(characterId)) {
            throw new Error(`Character does not exist: ${characterId}`);
        }

        const revision = state.revision + 1;
        const normalized = normalizeJSON(incoming ?? {});
        const messages = Array.isArray(normalized.message) ? normalized.message : [];
        let stub;
        if (currentRow) {
            stub = decodeValue(currentRow.stub_payload);
        } else {
            stub = { ...chatMetadata({ ...normalized, id: chatId }), id: chatId };
        }
        const content = { ...chatContent(normalized), id: chatId, message: messages };
        const canonical = mergeChatStubWithFullChat(stub, content);
        const etag = computeChatEtag(canonical);

        if (currentRow && etag === currentEtag
            && encodedEqual(assembleChat(currentRow, characterId, true), canonical)) {
            return {
                chat: canonical,
                etag,
                revision: state.revision,
                updatedAt: state.updatedAt,
                changed: false,
                projectionChanged: false,
            };
        }

        if (currentRow) {
            updateChatContent.run(
                encodeValue(chatContent(content)),
                etag,
                revision,
                characterId,
                chatId,
            );
        } else {
            insertChat.run(
                characterId,
                chatId,
                nextChatPosition.get(characterId).position,
                encodeValue(stub),
                encodeValue(chatContent(content)),
                etag,
                revision,
            );
        }
        deleteMessages.run(characterId, chatId);
        const usedMessages = new Set();
        for (let position = 0; position < messages.length; position++) {
            insertMessage.run(
                characterId,
                chatId,
                messageItemKey(messages[position], position, usedMessages),
                position,
                encodeValue(messages[position]),
                revision,
            );
        }
        const updatedAt = Date.now();
        updateState.run(revision, 1, updatedAt, STATE_ROW_ID);
        return {
            chat: canonical, etag, revision, updatedAt, changed: true,
            // Existing rows retain their stub metadata during content commits.
            projectionChanged: !currentRow,
        };
    });

    function commitChat(characterId, chatId, incoming, expectedEtag, options = {}) {
        if (!characterId || !chatId) throw new TypeError('characterId and chatId are required');
        return commitChatTransaction(
            characterId,
            chatId,
            incoming,
            expectedEtag,
            { requireExpected: options.requireExpected !== false },
        );
    }

    const deleteChatTransaction = db.transaction((characterId, chatId, expectedEtag) => {
        const state = getState();
        const row = selectChat.get(characterId, chatId);
        if (!row) return { deleted: false, revision: state.revision };
        if (expectedEtag && row.content_etag !== expectedEtag) {
            throw new AppDataConflictError('Chat content changed', {
                currentRevision: state.revision,
                currentEtag: row.content_etag,
            });
        }
        db.prepare(`
          DELETE FROM app_chats WHERE character_id = ? AND chat_id = ?
        `).run(characterId, chatId);
        const revision = state.revision + 1;
        const updatedAt = Date.now();
        updateState.run(revision, 1, updatedAt, STATE_ROW_ID);
        return { deleted: true, revision, updatedAt };
    });

    function deleteChat(characterId, chatId, expectedEtag) {
        return deleteChatTransaction(characterId, chatId, expectedEtag);
    }

    function clear(options = {}) {
        return db.transaction(() => {
            const state = assertExpectedRevision(options.expectedRevision);
            deleteAllProjectionRows();
            const revision = state.revision + 1;
            const updatedAt = Date.now();
            updateState.run(revision, 0, updatedAt, STATE_ROW_ID);
            return { revision, updatedAt };
        })();
    }

    function projectionEtag(options = {}) {
        const projection = exportProjection(options);
        return hashProjection(projection);
    }

    function projectionEtagFor(projection) {
        return hashProjection(projection);
    }

    return {
        clear,
        commitChat,
        deleteChat,
        estimateProjectionBytes,
        exportProjection,
        getChat,
        getChatStubAt,
        getState,
        hasChat,
        listCharacterStorage,
        listModuleStorage,
        pluginStorageFootprint,
        projectionEtag,
        projectionEtagFor,
        replaceFromProjection,
        syncStartupProjection,
        scanContentReferences,
    };
}

module.exports = {
    APP_DATA_SCHEMA_VERSION,
    AppDataConflictError,
    createAppDataStore,
};

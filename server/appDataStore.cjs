'use strict';

const { columnNames, toBuffer, withTransaction } = require('./sqlite.cjs');
const crypto = require('crypto');
const { createContentReferenceCollector, validateReferenceCandidates, matchContentReferences } = require('../shared/contentReferences.mjs');
const { Packr, Unpackr } = require('msgpackr');
const { normalizeJSON } = require('./utils/json.cjs');
const {
    computeChatEtag,
    MISSING_CHAT_ETAG,
    mergeChatMetadata,
} = require('./chatStore.cjs');
const { characterToPersistentShape } = require('./persistenceShape.cjs');
const { assertChatIdentity, chatMetadataFields, chatToStub, runtimeOnlyChatFields } = require('../shared/chatShape.mjs');
const { ensureDatabasePresetIds, ensureUniqueEntityIds } = require('../shared/entityIds.mjs');
const { normalizePromptPresetSelection } = require('../shared/promptPresetSelection.mjs');
const {
    classifiedPluginOwner,
    installedV3Plugins,
} = require('./pluginStorageProjection.cjs');

const APP_DATA_SCHEMA_VERSION = 2;
const STATE_ROW_ID = 1;
const PLUGIN_STORAGE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app_plugin_storage (
    namespace TEXT NOT NULL CHECK (namespace IN ('includedInSave', 'localStorage', 'localForage')),
    storage_key TEXT NOT NULL,
    payload BLOB NOT NULL,
    revision INTEGER NOT NULL,
    owner TEXT,
    PRIMARY KEY (namespace, storage_key)
  )
`;

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
    ensureDatabasePresetIds(normalized);
    normalizePromptPresetSelection(normalized);
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
    const generated = crypto.randomUUID();
    used.add(generated);
    return generated;
}

function collectionItemKey(item, position, used) {
    return uniqueKey(item?.id, position, used);
}

// List metadata is rebuilt from its fields alone. An incoming `_stub` marker
// (older clients, backups) is never trusted, and a hydrated chat or runtime
// placeholder can never replace the independently stored chat body.
function chatMetadata(chat, chatId) {
    return chatToStub({ ...withoutKeys(chat, ['_stub']), id: chatId });
}

function chatContent(chat) {
    // Stub/list metadata has a separate authoritative row. Never duplicate it
    // in the body payload: otherwise removing an optional stub key can expose
    // the stale body copy again during hydration.
    return withoutKeys(chat, [
        ...chatMetadataFields, ...runtimeOnlyChatFields, 'message',
    ]);
}

function characterMetadata(character) {
    return withoutKeys(characterToPersistentShape(character ?? {}), ['chaId', 'chats']);
}

function encodedEqual(left, right) {
    return encodeValue(left).equals(encodeValue(right));
}

function createAppDataStore(db) {
    if (typeof db?.prepare !== 'function') {
        throw new TypeError('createAppDataStore requires a SQLite database');
    }
    const sql = db.createTagStore();

    const pluginStorageColumns = columnNames(db, 'app_plugin_storage');
    if (pluginStorageColumns.size && !pluginStorageColumns.has('namespace')) {
        withTransaction(db, () => {
            db.exec(`
              ALTER TABLE app_plugin_storage RENAME TO app_plugin_storage_legacy;
              ${PLUGIN_STORAGE_TABLE_SQL};
              INSERT INTO app_plugin_storage (namespace, storage_key, payload, revision)
                SELECT 'includedInSave', storage_key, payload, revision FROM app_plugin_storage_legacy;
              DROP TABLE app_plugin_storage_legacy;
            `);
        });
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_data_state (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        revision       INTEGER NOT NULL DEFAULT 0,
        initialized    INTEGER NOT NULL DEFAULT 0,
        updated_at     INTEGER NOT NULL,
        metadata_revision INTEGER NOT NULL DEFAULT 0
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

      ${PLUGIN_STORAGE_TABLE_SQL};

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

    if (!columnNames(db, 'app_data_state').has('metadata_revision')) {
        db.exec('ALTER TABLE app_data_state ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0');
    }

    sql.run`
      INSERT OR IGNORE INTO app_data_state (id, schema_version, revision, initialized, updated_at)
      VALUES (${STATE_ROW_ID}, ${APP_DATA_SCHEMA_VERSION}, 0, 0, ${Date.now()})
    `;

    const readState = () => sql.get`
      SELECT schema_version, revision, initialized, updated_at, metadata_revision
      FROM app_data_state WHERE id = ${STATE_ROW_ID}
    `;
    // `revision` also advances on chat body commits. The startup projection
    // ETag needs a counter that moves only when that projection does, so a
    // body commit cannot fail an unrelated metadata patch.
    const saveState = (revision, updatedAt, metadataChanged) => sql.run`
      UPDATE app_data_state
      SET revision = ${revision}, initialized = 1, updated_at = ${updatedAt},
          metadata_revision = metadata_revision + ${metadataChanged ? 1 : 0}
      WHERE id = ${STATE_ROW_ID}
    `;

    const installedState = readState();
    if (installedState.schema_version === 1) {
        sql.run`UPDATE app_data_state SET schema_version = ${APP_DATA_SCHEMA_VERSION} WHERE id = ${STATE_ROW_ID}`;
    } else if (installedState.schema_version !== APP_DATA_SCHEMA_VERSION) {
        throw new Error(
            `Unsupported app data schema ${installedState.schema_version}; `
            + `expected ${APP_DATA_SCHEMA_VERSION}`,
        );
    }

    const insertRootField = (field, position, kind, collection, payload, revision) => sql.run`
      INSERT INTO app_root_fields (field_key, position, field_kind, collection, payload, revision)
      VALUES (${field}, ${position}, ${kind}, ${collection}, ${payload}, ${revision})
    `;
    const insertCharacter = (characterId, position, payload, revision) => sql.run`
      INSERT INTO app_characters (character_id, position, payload, revision)
      VALUES (${characterId}, ${position}, ${payload}, ${revision})
    `;
    const insertChat = (characterId, chatId, position, stub, content, etag, revision) => sql.run`
      INSERT INTO app_chats
        (character_id, chat_id, position, stub_payload, content_payload, content_etag, revision)
      VALUES (${characterId}, ${chatId}, ${position}, ${stub}, ${content}, ${etag}, ${revision})
    `;

    // Parent deletes cascade through chats and messages. The remaining
    // tables are independent projections of root domains.
    const deleteAllProjectionRows = () => db.exec(`
      DELETE FROM app_characters;
      DELETE FROM app_root_fields;
      DELETE FROM app_presets;
      DELETE FROM app_modules;
      DELETE FROM app_plugins;
      DELETE FROM app_personas;
      DELETE FROM app_plugin_storage WHERE namespace = 'includedInSave';
    `);

    function getState() {
        const row = readState();
        return {
            schemaVersion: row.schema_version,
            revision: row.revision,
            initialized: row.initialized === 1,
            updatedAt: row.updated_at,
            projectionEtag: `m${row.metadata_revision}`,
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
                    sql.run`
                        INSERT INTO app_presets (collection, item_key, position, payload, revision)
                        VALUES (${collection}, ${key}, ${position}, ${encodeValue(item)}, ${revision})
                    `;
                    break;
                case 'modules':
                    sql.run`
                        INSERT INTO app_modules (item_key, position, payload, revision)
                        VALUES (${key}, ${position}, ${encodeValue(item)}, ${revision})
                    `;
                    break;
                case 'plugins':
                    sql.run`
                        INSERT INTO app_plugins (collection, item_key, position, payload, revision)
                        VALUES (${collection}, ${key}, ${position}, ${encodeValue(item)}, ${revision})
                    `;
                    break;
                case 'personas':
                    sql.run`
                        INSERT INTO app_personas (item_key, position, payload, revision)
                        VALUES (${key}, ${position}, ${encodeValue(item)}, ${revision})
                    `;
                    break;
                default:
                    throw new Error(`Unknown collection table kind: ${tableKind}`);
            }
        }
    }

    function insertPluginStorageRows(value, revision) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        for (const key of Object.keys(value)) {
            sql.run`
                INSERT INTO app_plugin_storage (namespace, storage_key, payload, revision)
                VALUES ('includedInSave', ${key}, ${encodeValue(value[key])}, ${revision})
            `;
        }
    }

    function insertCharacterRows(characters, revision) {
        const usedCharacters = new Set();
        for (let position = 0; position < characters.length; position++) {
            const character = characters[position] ?? {};
            const characterId = persistentEntityId(character.chaId, usedCharacters);
            insertCharacter(
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
                ensureUniqueEntityIds(fullChat.message, crypto.randomUUID, 'chatId');
                const stub = chatMetadata(chat, chatId);
                const canonicalChat = mergeChatMetadata(stub, fullChat);
                insertChat(
                    characterId,
                    chatId,
                    chatPosition,
                    encodeValue(stub),
                    encodeValue(chatContent(fullChat)),
                    computeChatEtag(canonicalChat),
                    revision,
                );

                for (let messagePosition = 0; messagePosition < fullChat.message.length; messagePosition++) {
                    const message = fullChat.message[messagePosition];
                    sql.run`
                        INSERT INTO app_messages
                          (character_id, chat_id, message_key, position, payload, revision)
                        VALUES (${characterId}, ${chatId}, ${message.chatId}, ${messagePosition},
                            ${encodeValue(message)}, ${revision})
                    `;
                }
            }
        }
    }

    const replaceFromProjection = (value, options = {}) => withTransaction(db, () => {
        const projection = normalizedProjection(value);
        const state = assertExpectedRevision(options.expectedRevision);
        const revision = state.revision + 1;
        deleteAllProjectionRows();

        const keys = Object.keys(projection);
        if (!keys.includes('characters')) keys.unshift('characters');
        for (let position = 0; position < keys.length; position++) {
            const field = keys[position];
            const special = SPECIAL_ROOT_FIELDS.get(field);
            if (!special) {
                insertRootField(
                    field,
                    position,
                    'value',
                    null,
                    encodeValue(projection[field]),
                    revision,
                );
                continue;
            }

            insertRootField(
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
        saveState(revision, updatedAt, true);
        return { revision, updatedAt };
    });

    const pluginRows = collection => sql.all`
      SELECT payload FROM app_plugins WHERE collection = ${collection} ORDER BY position
    `;
    const rootPayload = field => sql.get`SELECT payload FROM app_root_fields WHERE field_key = ${field}`?.payload;
    const characterRows = () => sql.iterate`SELECT character_id, payload FROM app_characters ORDER BY position`;
    const chatRows = characterId => sql.iterate`
      SELECT chat_id, stub_payload, content_payload, content_etag
      FROM app_chats WHERE character_id = ${characterId} ORDER BY position
    `;

    function readCollection(kind, collection) {
        let rows;
        switch (kind) {
            case 'presets': rows = sql.all`
                SELECT payload FROM app_presets WHERE collection = ${collection} ORDER BY position
            `; break;
            case 'modules': rows = sql.all`SELECT payload FROM app_modules ORDER BY position`; break;
            case 'plugins': rows = pluginRows(collection); break;
            case 'personas': rows = sql.all`SELECT payload FROM app_personas ORDER BY position`; break;
            default: throw new Error(`Unknown collection kind: ${kind}`);
        }
        return rows.map(row => decodeValue(row.payload));
    }

    function readPluginStorage() {
        const result = {};
        for (const row of sql.all`
            SELECT storage_key, payload FROM app_plugin_storage WHERE namespace = 'includedInSave' ORDER BY rowid
        `) {
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
        const ownerPayload = rootPayload('pluginStorageMeta');
        const ownerMeta = decodeValue(ownerPayload) ?? {};
        const installedPlugins = pluginRows('legacy')
            .map(row => decodeValue(row.payload));
        const v3Plugins = installedV3Plugins(installedPlugins);
        const bytesByPlugin = new Map(
            Array.from(v3Plugins.keys(), name => [name, 0]),
        );
        let totalBytes = 0;
        let unclassifiedBytes = 0;
        for (const row of sql.all`
            SELECT storage_key, LENGTH(payload) AS bytes
            FROM app_plugin_storage WHERE namespace = 'includedInSave' ORDER BY rowid
        `) {
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

    /** One plain root setting, read without assembling the projection. */
    function getRootValue(field) {
        return decodeValue(rootPayload(field));
    }

    function readMessages(characterId, chatId) {
        return sql.all`
            SELECT payload FROM app_messages
            WHERE character_id = ${characterId} AND chat_id = ${chatId} ORDER BY position
        `
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
        return mergeChatMetadata(stub, content);
    }

    function readCharacters(includeMessages) {
        return Array.from(characterRows(), row => ({
            ...characterMetadata(decodeValue(row.payload)),
            chaId: row.character_id,
            chats: Array.from(chatRows(row.character_id),
                chat => assembleChat(chat, row.character_id, includeMessages)),
        }));
    }

    function exportProjection(options = {}) {
        const includeMessages = options.includeMessages !== false;
        const result = {};
        for (const row of sql.all`
            SELECT field_key, field_kind, collection, payload
            FROM app_root_fields ORDER BY position
        `) {
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

    // Only what folder visibility depends on, without plugin storage, presets or modules.
    function exportFolderProjection() {
        return { characterOrder: getRootValue('characterOrder') ?? [], characters: readCharacters(false) };
    }

    // A consistent server snapshot, decoding one chat at a time. Only the
    // caller-owned candidates receive usage flags; no text or ids leave the server.
    const scanContentReferences = (kind, candidates) => withTransaction(db, () => {
        validateReferenceCandidates(kind, candidates);
        const collector = createContentReferenceCollector(kind);
        for (const row of characterRows()) {
            collector.addCharacter(decodeValue(row.payload));
            for (const chat of chatRows(row.character_id)) {
                collector.addChat(assembleChat(chat, row.character_id, true));
            }
        }
        return matchContentReferences(collector.result(), candidates);
    });

    function estimateProjectionBytes() {
        return Number(sql.get`
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
        `?.payload_bytes ?? 0);
    }

    function listCharacterStorage() {
        return sql.all`
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
        `.map(row => ({
            character: { ...characterMetadata(decodeValue(row.payload)), chaId: row.character_id },
            cardBytes: Number(row.card_bytes ?? 0),
            chatBytes: Number(row.chat_bytes ?? 0),
        }));
    }

    function listModuleStorage() {
        return sql.all`
            SELECT payload, LENGTH(payload) AS body_bytes
            FROM app_modules ORDER BY position
        `.map(row => ({
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
                        return chatMetadata(chat, chatId);
                    }),
                };
            });
        }
        return result;
    }

    function clearSpecialRows(special) {
        switch (special.kind) {
            case 'characters':
                sql.run`DELETE FROM app_characters`;
                break;
            case 'presets':
                sql.run`
                    DELETE FROM app_presets WHERE collection = ${special.collection}
                `;
                break;
            case 'modules':
                sql.run`DELETE FROM app_modules`;
                break;
            case 'plugins':
                sql.run`
                    DELETE FROM app_plugins WHERE collection = ${special.collection}
                `;
                break;
            case 'personas':
                sql.run`DELETE FROM app_personas`;
                break;
            case 'plugin-storage':
                sql.run`DELETE FROM app_plugin_storage WHERE namespace = 'includedInSave'`;
                break;
            default:
                throw new Error(`Unknown root field kind: ${special.kind}`);
        }
    }

    // Shared reconciliation for payload-backed collections and chat messages.
    // SQL identifiers come only from the fixed adapters below, never requests.
    // Call inside the owning transaction so temporary positions cannot escape.
    function createPayloadRowSync(table, keyColumn, scopeColumns = [], ordered = true) {
        const scopeWhere = scopeColumns.map(column => `${column} = ?`).join(' AND ');
        const where = scopeWhere ? `${scopeWhere} AND ` : '';
        const select = db.prepare(`SELECT ${keyColumn} AS item_key, payload${ordered ? ', position' : ''}
            FROM ${table}${scopeWhere ? ` WHERE ${scopeWhere}` : ''}`);
        const remove = db.prepare(`DELETE FROM ${table} WHERE ${where}${keyColumn} = ?`);
        const move = ordered ? db.prepare(`UPDATE ${table} SET position = ?
            WHERE ${where}${keyColumn} = ?`) : null;
        const updatePosition = ordered ? db.prepare(`UPDATE ${table} SET position = ?, revision = ?
            WHERE ${where}${keyColumn} = ?`) : null;
        const update = db.prepare(`UPDATE ${table} SET payload = ?, revision = ?${ordered ? ', position = ?' : ''}
            WHERE ${where}${keyColumn} = ?`);
        const columns = [...scopeColumns, keyColumn, 'payload', 'revision', ...(ordered ? ['position'] : [])];
        const insert = db.prepare(`INSERT INTO ${table} (${columns.join(', ')})
            VALUES (${columns.map(() => '?').join(', ')})`);

        return (scope, items, revision) => {
            const currentRows = select.all(...scope);
            const currentById = new Map(currentRows.map(row => [row.item_key, row]));
            const desiredIds = new Set(items.map(item => item.key));
            for (const row of currentRows) {
                if (!desiredIds.has(row.item_key)) remove.run(...scope, row.item_key);
            }
            // Vacate only moved rows before assigning final positions. This
            // handles swaps and insertions under UNIQUE(scope, position), while
            // untouched rows receive no UPDATE at all.
            if (ordered) {
                for (let position = 0; position < items.length; position++) {
                    const row = currentById.get(items[position].key);
                    if (row && row.position !== position) {
                        move.run(-row.position - 1, ...scope, row.item_key);
                    }
                }
            }
            for (let position = 0; position < items.length; position++) {
                const item = items[position];
                const row = currentById.get(item.key);
                const payload = encodeValue(item.value);
                const order = ordered ? [position] : [];
                if (!row) {
                    insert.run(...scope, item.key, payload, revision, ...order);
                } else if (!payload.equals(row.payload)) {
                    update.run(payload, revision, ...order, ...scope, item.key);
                } else if (ordered && row.position !== position) {
                    updatePosition.run(position, revision, ...scope, item.key);
                }
            }
        };
    }

    const payloadRowSync = {
        presets: createPayloadRowSync('app_presets', 'item_key', ['collection']),
        modules: createPayloadRowSync('app_modules', 'item_key'),
        plugins: createPayloadRowSync('app_plugins', 'item_key', ['collection']),
        personas: createPayloadRowSync('app_personas', 'item_key'),
        'plugin-storage': createPayloadRowSync('app_plugin_storage', 'storage_key', ['namespace'], false),
        messages: createPayloadRowSync('app_messages', 'message_key', ['character_id', 'chat_id']),
    };

    function keyedItems(value, itemKey) {
        const used = new Set();
        return (Array.isArray(value) ? value : []).map((item, position) => ({
            key: itemKey(item, position, used), value: item,
        }));
    }

    function syncSpecialRows(special, value, revision) {
        const items = special.kind === 'plugin-storage'
            ? Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
                .map(([key, value]) => ({ key, value }))
            : keyedItems(value, collectionItemKey);
        const scope = special.kind === 'plugin-storage' ? ['includedInSave']
            : special.collection ? [special.collection] : [];
        payloadRowSync[special.kind](scope, items, revision);
    }

    function sameOrderedIds(currentRows, desiredItems, currentKey, desiredKey) {
        return currentRows.length === desiredItems.length
            && currentRows.every((row, index) => (
                currentKey(row) === desiredKey(desiredItems[index])
            ));
    }

    function syncChatRows(characterId, desiredChats, revision) {
        const currentRows = sql.all`
            SELECT chat_id, position, stub_payload, content_payload, content_etag, revision
            FROM app_chats WHERE character_id = ${characterId} ORDER BY position
        `;
        const currentById = new Map(currentRows.map(row => [row.chat_id, row]));
        const desiredIds = new Set(desiredChats.map(chat => chat.id));
        const orderChanged = !sameOrderedIds(
            currentRows,
            desiredChats,
            row => row.chat_id,
            chat => chat.id,
        );

        if (orderChanged && currentRows.length > 0) {
            sql.run`
                UPDATE app_chats SET position = -position - 1 WHERE character_id = ${characterId}
            `;
        }
        for (const row of currentRows) {
            if (!desiredIds.has(row.chat_id)) {
                sql.run`
                    DELETE FROM app_chats WHERE character_id = ${characterId} AND chat_id = ${row.chat_id}
                `;
            }
        }

        for (let position = 0; position < desiredChats.length; position++) {
            const stub = desiredChats[position];
            const currentRow = currentById.get(stub.id);
            if (!currentRow) {
                const content = { id: stub.id, message: [] };
                const canonical = mergeChatMetadata(stub, content);
                insertChat(
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
                const reconciled = mergeChatMetadata(stub, currentFullChat);
                content = chatContent(reconciled);
                etag = computeChatEtag(reconciled);
            }
            sql.run`
                UPDATE app_chats
                SET position = ${position}, stub_payload = ${encodeValue(stub)},
                    content_payload = ${encodeValue(content)}, content_etag = ${etag},
                    revision = ${stubChanged || positionChanged ? revision : currentRow.revision}
                WHERE character_id = ${characterId} AND chat_id = ${stub.id}
            `;
        }
    }

    function syncCharacterRows(desiredCharacters, revision) {
        const currentRows = sql.all`
            SELECT character_id, position, payload, revision
            FROM app_characters ORDER BY position
        `;
        const currentById = new Map(currentRows.map(row => [row.character_id, row]));
        const desiredIds = new Set(desiredCharacters.map(character => character.chaId));
        const orderChanged = !sameOrderedIds(
            currentRows,
            desiredCharacters,
            row => row.character_id,
            character => character.chaId,
        );

        if (orderChanged && currentRows.length > 0) sql.run`
            UPDATE app_characters SET position = -position - 1
        `;
        for (const row of currentRows) {
            if (!desiredIds.has(row.character_id)) sql.run`
                DELETE FROM app_characters WHERE character_id = ${row.character_id}
            `;
        }

        for (let position = 0; position < desiredCharacters.length; position++) {
            const character = desiredCharacters[position];
            const metadata = characterMetadata(character);
            const currentRow = currentById.get(character.chaId);
            if (!currentRow) {
                insertCharacter(
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
                    const rowRevision = metadataChanged || positionChanged ? revision : currentRow.revision;
                    sql.run`
                        UPDATE app_characters
                        SET position = ${position}, payload = ${encodeValue(metadata)}, revision = ${rowRevision}
                        WHERE character_id = ${character.chaId}
                    `;
                }
            }
            syncChatRows(character.chaId, character.chats, revision);
        }
    }

    /**
     * Synchronize the browser's complete, stubs-only startup projection.
     * Root/character/chat metadata and ordering are authoritative here; chat
     * content and message rows remain owned by commitChat().
     */
    const syncStartupProjection = (incoming, options = {}) => withTransaction(db, () => {
        const state = getState();
        const currentEtag = state.projectionEtag;
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

        const current = exportProjection({ includeMessages: false });
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
                syncSpecialRows(special, desired[field], revision);
            }
        }

        const rootRows = sql.all`
            SELECT field_key, position, field_kind, collection, payload, revision
            FROM app_root_fields ORDER BY position
        `;
        const rootByField = new Map(rootRows.map(row => [row.field_key, row]));
        const rootOrderChanged = !sameOrderedIds(
            rootRows,
            desiredKeys,
            row => row.field_key,
            field => field,
        );
        if (rootOrderChanged && rootRows.length > 0) sql.run`
            UPDATE app_root_fields SET position = -position - 1
        `;
        for (const row of rootRows) {
            if (!desiredKeySet.has(row.field_key)) sql.run`
                DELETE FROM app_root_fields WHERE field_key = ${row.field_key}
            `;
        }
        for (let position = 0; position < desiredKeys.length; position++) {
            const field = desiredKeys[position];
            const special = SPECIAL_ROOT_FIELDS.get(field);
            const kind = special?.kind ?? 'value';
            const collection = special?.collection ?? null;
            const payload = special ? null : encodeValue(desired[field]);
            const currentRow = rootByField.get(field);
            if (!currentRow) {
                insertRootField(
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
                sql.run`
                    UPDATE app_root_fields
                    SET position = ${position}, field_kind = ${kind}, collection = ${collection}, payload = ${payload},
                        revision = ${rowChanged ? revision : currentRow.revision}
                    WHERE field_key = ${field}
                `;
            }
        }

        const updatedAt = Date.now();
        saveState(revision, updatedAt, true);
        return { changed: true, revision, updatedAt, etag: getState().projectionEtag };
    });

    const chatRow = (characterId, chatId) => sql.get`
      SELECT chat_id, stub_payload, content_payload, content_etag, position
      FROM app_chats WHERE character_id = ${characterId} AND chat_id = ${chatId}
    `;

    /** The full chat with the content ETag that commitChat() compares against. */
    function getChatState(characterId, chatId) {
        const row = chatRow(characterId, chatId);
        return row
            ? { chat: assembleChat(row, characterId, true), etag: row.content_etag }
            : undefined;
    }

    function getChatStubAt(characterId, position) {
        const row = sql.get`
            SELECT chat_id, stub_payload
            FROM app_chats WHERE character_id = ${characterId} AND position = ${position}
        `;
        return row ? decodeValue(row.stub_payload) : undefined;
    }

    function hasChat(characterId, chatId) {
        return Boolean(chatRow(characterId, chatId));
    }

    /** Commit a full chat body; an existing row requires its current content ETag. */
    const commitChat = (characterId, chatId, incoming, expectedEtag) => withTransaction(db, () => {
        if (!characterId || !chatId) throw new TypeError('characterId and chatId are required');
        const state = getState();
        const currentRow = chatRow(characterId, chatId);
        const currentEtag = currentRow?.content_etag ?? MISSING_CHAT_ETAG;
        if ((currentRow && !expectedEtag) || (expectedEtag && expectedEtag !== currentEtag)) {
            throw new AppDataConflictError('Chat content changed', {
                currentRevision: state.revision,
                currentEtag,
            });
        }
        if (!sql.get`
            SELECT 1 AS found FROM app_characters WHERE character_id = ${characterId}
        `) {
            throw new Error(`Character does not exist: ${characterId}`);
        }

        const revision = state.revision + 1;
        const normalized = normalizeJSON(incoming ?? {});
        assertChatIdentity(normalized, chatId);
        const messages = normalized.message;
        let stub;
        if (currentRow) {
            stub = decodeValue(currentRow.stub_payload);
        } else {
            stub = chatMetadata(normalized, chatId);
        }
        const content = { ...chatContent(normalized), id: chatId, message: messages };
        const canonical = mergeChatMetadata(stub, content);
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
            sql.run`
                UPDATE app_chats
                SET content_payload = ${encodeValue(chatContent(content))}, content_etag = ${etag}, revision = ${revision}
                WHERE character_id = ${characterId} AND chat_id = ${chatId}
            `;
        } else {
            insertChat(
                characterId,
                chatId,
                sql.get`
                    SELECT COALESCE(MAX(position) + 1, 0) AS position
                    FROM app_chats WHERE character_id = ${characterId}
                `.position,
                encodeValue(stub),
                encodeValue(chatContent(content)),
                etag,
                revision,
            );
        }
        payloadRowSync.messages(
            [characterId, chatId],
            messages.map(message => ({ key: message.chatId, value: message })),
            revision,
        );
        const updatedAt = Date.now();
        saveState(revision, updatedAt, !currentRow);
        return {
            chat: canonical, etag, revision, updatedAt, changed: true,
            // Existing rows retain their stub metadata during content commits.
            projectionChanged: !currentRow,
        };
    });

    function assertPluginStorageNamespace(namespace) {
        if (namespace !== 'localStorage' && namespace !== 'localForage') {
            throw new TypeError(`Unsupported plugin storage namespace: ${namespace}`);
        }
    }

    function getPluginStorage(namespace, key) {
        assertPluginStorageNamespace(namespace);
        return toBuffer(sql.get`
            SELECT payload FROM app_plugin_storage WHERE namespace = ${namespace} AND storage_key = ${key}
        `?.payload) ?? null;
    }

    function listPluginStorage(namespace) {
        assertPluginStorageNamespace(namespace);
        return sql.all`
            SELECT storage_key AS key, owner FROM app_plugin_storage WHERE namespace = ${namespace} ORDER BY rowid
        `.map(({ key, owner }) => ({
            key, ...(owner ? { owner } : {}),
        }));
    }

    function writePluginStorage(namespace, key, value, owner, options = {}) {
        assertPluginStorageNamespace(namespace);
        if (typeof key !== 'string' || !(value instanceof Uint8Array)
            || (owner !== undefined && typeof owner !== 'string')) {
            throw new TypeError('Invalid plugin storage entry');
        }
        owner ||= null;
        if (options.ifAbsent) {
            sql.run`
              INSERT OR IGNORE INTO app_plugin_storage (namespace, storage_key, payload, revision, owner)
              VALUES (${namespace}, ${key}, ${value}, 1, ${owner})
            `;
        } else {
            sql.run`
              INSERT INTO app_plugin_storage (namespace, storage_key, payload, revision, owner)
              VALUES (${namespace}, ${key}, ${value}, 1, ${owner})
              ON CONFLICT (namespace, storage_key) DO UPDATE SET
                payload = excluded.payload, revision = app_plugin_storage.revision + 1,
                owner = COALESCE(excluded.owner, app_plugin_storage.owner)
            `;
        }
    }

    function removePluginStorage(namespace, key) {
        assertPluginStorageNamespace(namespace);
        sql.run`
            DELETE FROM app_plugin_storage WHERE namespace = ${namespace} AND storage_key = ${key}
        `;
    }

    function clearPluginStorage(namespace) {
        assertPluginStorageNamespace(namespace);
        sql.run`DELETE FROM app_plugin_storage WHERE namespace = ${namespace}`;
    }

    function* exportPluginStorage() {
        for (const row of sql.iterate`
            SELECT namespace, storage_key AS key, payload AS value, owner
            FROM app_plugin_storage WHERE namespace != 'includedInSave' ORDER BY rowid
        `) yield { ...row, value: toBuffer(row.value) };
    }

    const replacePluginStorage = entries => withTransaction(db, () => {
        clearPluginStorage('localStorage');
        clearPluginStorage('localForage');
        for (const { namespace, key, value, owner } of entries) {
            writePluginStorage(namespace, key, value, owner ?? undefined);
        }
    });

    const importPluginStorage = (namespace, entries) => withTransaction(db, () => {
        for (const { key, value, owner } of entries) {
            writePluginStorage(namespace, key, value, owner, { ifAbsent: true });
        }
    });

    if (sql.get`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'`) {
        withTransaction(db, () => {
            const prefix = 'cache/plugin-storage/';
            const read = key => sql.get`SELECT value FROM kv WHERE key = ${key}`?.value;
            for (const { key } of sql.all`SELECT key FROM kv WHERE substr(key, 1, ${prefix.length}) = ${prefix}`) {
                const encodedKey = key.slice(prefix.length, -'.json'.length);
                const decodedKey = Buffer.from(encodedKey, 'base64url').toString('utf-8');
                if (!key.endsWith('.json') || Buffer.from(decodedKey).toString('base64url') !== encodedKey) continue;
                const metadataKey = `cache/plugin-storage-meta/${encodedKey}.json`;
                let owner;
                try {
                    owner = JSON.parse(toBuffer(read(metadataKey))?.toString('utf-8') ?? '{}').plugin;
                } catch {}
                writePluginStorage('localForage', decodedKey, read(key),
                    typeof owner === 'string' ? owner : undefined, { ifAbsent: true });
                sql.run`DELETE FROM kv WHERE key IN (${key}, ${metadataKey})`;
            }
        });
    }

    return {
        commitChat,
        estimateProjectionBytes,
        exportProjection,
        exportFolderProjection,
        getChatState,
        getChatStubAt,
        getRootValue,
        getState,
        hasChat,
        listCharacterStorage,
        listModuleStorage,
        getPluginStorage,
        listPluginStorage,
        writePluginStorage,
        removePluginStorage,
        clearPluginStorage,
        exportPluginStorage,
        replacePluginStorage,
        importPluginStorage,
        pluginStorageFootprint,
        replaceFromProjection,
        syncStartupProjection,
        scanContentReferences,
    };
}

module.exports = {
    AppDataConflictError,
    createAppDataStore,
};

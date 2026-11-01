'use strict';

const { withTransaction } = require('./sqlite.cjs');
const nodeCrypto = require('crypto');
const { codes: API_ERROR_CODES, createApiError } = require('./utils/apiErrors.cjs');
const { removeRuntimeCharacterFields } = require('./persistenceShape.cjs');
const {
    AppDataMigrationCleanupError,
    createAppDataMigration,
    migratePromptPresetSelection,
} = require('./appDataMigration.cjs');
const { createLegacyRestoreService } = require('./dataRestore/index.cjs');
const { decodeRisuSave } = require('./utils/risuSave.cjs');
const { normalizeJSON } = require('./utils/json.cjs');
const { importPromptPresetSelection } = require('../shared/promptPresetSelection.mjs');
const { normalizeTrashRetentionDays } = require('../shared/trashRetention.mjs');
const { applyGenerationInputMetadata } = require('./revenant/generationInputMetadata.cjs');
const { applyMutationPatch } = require('./revenant/materializer.cjs');

function assignMissingPersistentIds(dbObj) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    const characterIds = new Set();
    for (const char of dbObj.characters) {
        if (!char) continue;
        if (!char.chaId || characterIds.has(char.chaId)) {
            char.chaId = nodeCrypto.randomUUID();
            changed = true;
        }
        characterIds.add(char.chaId);
        if (!char?.chats) continue;
        const chatIds = new Set();
        for (const chat of char.chats) {
            // A metadata-only legacy entry names a body stored elsewhere;
            // renaming it here would orphan that body.
            if (!Array.isArray(chat?.message)) continue;
            if (!chat.id || chatIds.has(chat.id)) {
                chat.id = nodeCrypto.randomUUID();
                changed = true;
            }
            chatIds.add(chat.id);
            const messageIds = new Set();
            for (const message of chat.message) {
                if (!message) continue;
                if (typeof message.chatId !== 'string' || !message.chatId || messageIds.has(message.chatId)) {
                    message.chatId = nodeCrypto.randomUUID();
                    changed = true;
                }
                messageIds.add(message.chatId);
            }
        }
    }
    return changed;
}

// Older saves can keep a folderId for a deleted folder, which hides the chat
// from every sidebar section; clear it so those chats show up again.
function normalizeOrphanFolderIds(dbObj) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        const validIds = new Set((char.chatFolders ?? []).map(f => f?.id).filter(Boolean));
        for (const chat of char.chats) {
            if (!chat) continue;
            if (chat.folderId && !validIds.has(chat.folderId)) {
                chat.folderId = null;
                changed = true;
            }
        }
    }
    return changed;
}

function createCanonicalStorage({
    sqliteDb,
    kvGet,
    kvSet,
    kvSetChunked,
    kvDel,
    checkpointWal,
    appDataStore,
    bookmarkStore,
    logger,
    scheduleBackupAndRotate,
    refreshTrashRetention,
}) {
    const {
        normalizeColdStorageStorageKey,
        normalizeColdStorageBackupBuffer,
        listColdStorageBackupEntries,
        restoreColdStorageInDb,
        restoreColdStorageChat,
    } = createLegacyRestoreService({
        sqliteDb,
        kvGet,
        kvSet,
        kvDel,
        logger,
    });

    const appDataMigration = createAppDataMigration({
        db: sqliteDb,
        appDataStore,
        kv: {
            get: kvGet,
            delete: kvDel,
        },
        decodeLegacyBlob: async raw => {
            const decoded = await decodeRisuSave(raw);
            const { database } = normalizeLegacyDatabaseProjection(decoded);
            // Relational rows omit chatPage and runtime fields; verify against that shape.
            for (const char of database.characters ?? []) removeRuntimeCharacterFields(char);
            return database;
        },
        normalizeProjection: normalizeJSON,
    });

    let appDataReadyPromise = null;

    function normalizeLegacyDatabaseProjection(dbObj, options) {
        const normalized = normalizeJSON(dbObj);
        importPromptPresetSelection(normalized);
        assignMissingPersistentIds(normalized);
        normalizeOrphanFolderIds(normalized);

        const coldRestoreResult = restoreColdStorageInDb(normalized, options);
        return { database: normalized, coldRestoreResult };
    }

    let trashRetentionDays = normalizeTrashRetentionDays(undefined);

    function readTrashRetentionDays() {
        return appDataStore.getState().initialized
            ? appDataStore.getRootValue('trashRetentionDays')
            : undefined;
    }

    function syncTrashRetention() {
        const next = normalizeTrashRetentionDays(readTrashRetentionDays());
        if (next === trashRetentionDays) return;
        trashRetentionDays = next;
        const refresh = refreshTrashRetention?.();
        if (refresh) {
            void refresh.catch(error => {
                logger.warn('[Drive] Failed to refresh trash retention:', error);
            });
        }
    }

    async function ensureCanonicalStorage() {
        if (appDataReadyPromise) return appDataReadyPromise;
        appDataReadyPromise = (async () => {
            // Preserve the exact pre-cutover bytes as a downgrade/recovery escape
            // hatch; the live blob is deleted after relational install verifies.
            const originalLegacyBlob = kvGet('database/database.bin');
            if (originalLegacyBlob
                && !appDataStore.getState().initialized
                && !appDataMigration.getMarker()) {
                const sourceHash = nodeCrypto.createHash('sha256')
                    .update(originalLegacyBlob)
                    .digest('hex');
                const backupKey = `migration-backup/pre-relational-${sourceHash.slice(0, 16)}.bin`;
                if (!kvGet(backupKey)) {
                    kvSetChunked(backupKey, Buffer.from(originalLegacyBlob));
                }
            }
            try {
                await appDataMigration.run();
            } catch (error) {
                if (!(error instanceof AppDataMigrationCleanupError)
                    || !appDataStore.getState().initialized) {
                    throw error;
                }
                logger.warn('[AppData] Canonical rows installed; legacy blob cleanup will retry:', error);
            }

            migratePromptPresetSelection({ db: sqliteDb, appDataStore });

            if (appDataStore.getState().initialized) {
                const fullProjection = appDataStore.exportProjection({ includeMessages: true });
                const idsAssigned = assignMissingPersistentIds(fullProjection);
                // Bookmarks already have a canonical relational store. Ingest the
                // compatibility fields once, then remove them from chat payloads.
                const bookmarkMigration = bookmarkStore.needsLegacyMigration()
                    ? bookmarkStore.migrateLegacyDatabase(fullProjection)
                    : { changed: false };
                if (idsAssigned || bookmarkMigration.changed) {
                    appDataStore.replaceFromProjection(fullProjection, {
                        expectedRevision: appDataStore.getState().revision,
                    });
                }
            }
            syncTrashRetention();
        })().catch(error => {
            appDataReadyPromise = null;
            throw error;
        });
        return appDataReadyPromise;
    }

    async function prepareDatabaseExport() {
        await ensureCanonicalStorage();

        const checkpoint = checkpointWal('FULL');
        if (!checkpoint
            || checkpoint.busy > 0
            || checkpoint.log !== checkpoint.checkpointed) {
            throw createApiError(API_ERROR_CODES.DATABASE_LOCKED, 503, checkpoint && {
                busy: checkpoint.busy,
                log: checkpoint.log,
                checkpointed: checkpoint.checkpointed,
            });
        }
    }

    // Commit restored cold-storage bodies under the row's ETag; if restoration
    // fails, return the stored chat with coldRestoreFailed.
    async function loadCanonicalChat(characterId, chatId) {
        await ensureCanonicalStorage();
        if (!appDataStore.getState().initialized || !characterId || !chatId) return undefined;
        const state = appDataStore.getChatState(characterId, chatId);
        if (!state) return undefined;
        const { chat } = state;
        const storedMessages = chat.message;
        let coldRestoreFailed;
        try {
            coldRestoreFailed = !restoreColdStorageChat(chat);
        } catch (error) {
            logger.error(`[ColdStorage] restore failed for ${characterId}/${chatId}:`, error);
            coldRestoreFailed = true;
        }
        const restored = chat.message !== storedMessages;
        if (!restored) return { ...state, coldRestoreFailed };
        assignMissingPersistentIds({ characters: [{ chaId: characterId, chats: [chat] }] });
        const committed = appDataStore.commitChat(characterId, chatId, chat, state.etag);
        return { chat: committed.chat, etag: committed.etag, coldRestoreFailed };
    }

    // Update activity metadata from the store in the same transaction so
    // concurrent devices do not race using client-side snapshots.
    async function persistCanonicalChat({
        characterId,
        chatId,
        chat,
        expectedEtag,
        generationInput = false,
        mutationPatch,
    }) {
        await ensureCanonicalStorage();
        if (!appDataStore.getState().initialized) {
            throw new Error('Canonical relational database is missing');
        }
        let committed;
        let metadata;
        withTransaction(sqliteDb, () => {
            committed = appDataStore.commitChat(characterId, chatId, chat, expectedEtag);
            if (!generationInput && !mutationPatch) return;
            const nextDb = appDataStore.exportProjection({ includeMessages: false });
            if (generationInput) {
                metadata = applyGenerationInputMetadata(nextDb, characterId);
                if (!metadata) {
                    const error = new Error('Generation input character not found');
                    error.httpStatus = 404;
                    throw error;
                }
            }
            if (mutationPatch) applyMutationPatch(nextDb, characterId, mutationPatch);
            appDataStore.syncStartupProjection(nextDb);
        });
        try {
            scheduleBackupAndRotate();
        } catch (error) {
            logger.warn('[CanonicalChat] Backup rotation failed:', error);
        }
        return { ...committed, metadata };
    }

    return {
        normalizeColdStorageStorageKey,
        normalizeColdStorageBackupBuffer,
        listColdStorageBackupEntries,
        normalizeLegacyDatabaseProjection,
        readTrashRetentionDays,
        syncTrashRetention,
        ensureCanonicalStorage,
        prepareDatabaseExport,
        loadCanonicalChat,
        persistCanonicalChat,
    };
}

module.exports = { createCanonicalStorage };

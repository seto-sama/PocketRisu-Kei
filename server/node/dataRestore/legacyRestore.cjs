'use strict';

const zlib = require('zlib');

const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';

function createLegacyRestoreService({
    sqliteDb,
    kvGet,
    kvSet,
    kvDel,
    logger,
}) {
    function isInvalidPathSegment(name) {
        return (
            !name ||
            name.includes('\0') ||
            name.includes('\\') ||
            name.startsWith('/') ||
            name.includes('../') ||
            name.includes('/..') ||
            name === '.' ||
            name === '..'
        );
    }

    function normalizeColdStorageStorageKey(nameOrKey) {
        let key = String(nameOrKey || '');
        if (key.startsWith('coldstorage/')) key = key.slice('coldstorage/'.length);
        else if (key.startsWith('coldstorage_')) key = key.slice('coldstorage_'.length);
        if (key.endsWith('.json')) key = key.slice(0, -'.json'.length);
        if (!key || key.includes('/') || isInvalidPathSegment(key)) {
            throw new Error(`Invalid cold storage entry name: ${nameOrKey}`);
        }
        return `coldstorage/${key}`;
    }

    function toColdStorageBackupName(storageKey) {
        return `${normalizeColdStorageStorageKey(storageKey)}.json`;
    }

    function parseColdStorageJsonBuffer(buffer, sourceLabel, options = {}) {
        const { allowPlainJson = false } = options;
        try {
            const decompressed = zlib.gunzipSync(buffer);
            return {
                coldData: JSON.parse(decompressed.toString('utf-8')),
                format: 'gzip',
            };
        } catch (gzipError) {
            if (!allowPlainJson) throw gzipError;
            try {
                return {
                    coldData: JSON.parse(buffer.toString('utf-8')),
                    format: 'plain-json',
                };
            } catch (jsonError) {
                throw new Error(
                    `[ColdStorage] failed to parse ${sourceLabel}: ` +
                    `gzip=${gzipError.message}; json=${jsonError.message}`,
                );
            }
        }
    }

    function encodeColdStorageCanonicalBuffer(coldData) {
        return Buffer.from(zlib.gzipSync(Buffer.from(JSON.stringify(coldData), 'utf-8')));
    }

    function normalizeColdStorageBackupBuffer(buffer, sourceLabel) {
        try {
            const { coldData } = parseColdStorageJsonBuffer(buffer, sourceLabel, {
                allowPlainJson: true,
            });
            return encodeColdStorageCanonicalBuffer(coldData);
        } catch (error) {
            // Keep unreadable entries in KV so database references can remain
            // as recovery breadcrumbs after an import.
            logger.warn?.(
                `[ColdStorage] preserving unreadable backup entry ${sourceLabel}:`,
                error.message,
            );
            return Buffer.from(buffer);
        }
    }

    function readColdStorageJsonEntry(nameOrKey, options = {}) {
        const { migrateLegacy = false, allowPlainJsonFallback = false } = options;
        const canonicalKey = normalizeColdStorageStorageKey(nameOrKey);
        const legacyBackupKey = `${canonicalKey}.json`;
        let storageKey = canonicalKey;
        let value = kvGet(canonicalKey);
        if (!value) {
            storageKey = legacyBackupKey;
            value = kvGet(legacyBackupKey);
        }
        if (!value) return null;
        const parsed = parseColdStorageJsonBuffer(value, storageKey, {
            allowPlainJson: allowPlainJsonFallback || storageKey !== canonicalKey,
        });
        if (migrateLegacy && (storageKey !== canonicalKey || parsed.format !== 'gzip')) {
            kvSet(canonicalKey, encodeColdStorageCanonicalBuffer(parsed.coldData));
            if (storageKey !== canonicalKey) kvDel(storageKey);
        }
        return {
            coldData: parsed.coldData,
            storageKey,
            canonicalKey,
            format: parsed.format,
        };
    }

    function listColdStorageBackupEntries() {
        const keys = sqliteDb.prepare(
            `SELECT key FROM kv WHERE key LIKE 'coldstorage/%'`,
        ).all();
        const canonicalKeys = Array.from(new Set(
            keys.map((row) => normalizeColdStorageStorageKey(row.key)),
        )).sort((a, b) => a.localeCompare(b));
        return canonicalKeys.map((storageKey) => {
            const entry = readColdStorageJsonEntry(storageKey, {
                migrateLegacy: true,
                allowPlainJsonFallback: true,
            });
            if (!entry) {
                throw new Error(
                    `[ColdStorage] missing cold storage entry while exporting: ${storageKey}`,
                );
            }
            const plainJson = Buffer.from(JSON.stringify(entry.coldData), 'utf-8');
            const backupName = toColdStorageBackupName(storageKey);
            return {
                kind: 'buffer',
                buffer: plainJson,
                backupName,
                sortKey: backupName,
                size: plainJson.length,
            };
        });
    }

    function restoreColdStorageCharacter(character) {
        if (!character?.coldstorage) return true;
        const key = character.coldstorage;
        const entry = readColdStorageJsonEntry(key, { migrateLegacy: true });
        if (!entry) {
            logger.error(`[ColdStorage] character data not found for key: ${key}`);
            return false;
        }
        try {
            if (!entry.coldData?.character) {
                logger.error(`[ColdStorage] unexpected character cold data format for key: ${key}`);
                return false;
            }
            Object.assign(character, entry.coldData.character);
            delete character.coldstorage;
            delete character.coldStoragedChats;
            return true;
        } catch (error) {
            logger.error(`[ColdStorage] character restore failed for key ${key}:`, error.message);
            return false;
        }
    }

    function promoteFailedColdStorageStub(char) {
        const coldKey = char.coldstorage;
        const defaults = {
            firstMessage: '', desc: '', notes: '', chatFolders: [],
            emotionImages: [], bias: [], viewScreen: 'none', globalLore: [],
            sdData: [
                ['always', 'solo, 1girl'], ['negative', ''],
                ["|character's appearance", ''], ['current situation', ''],
                ["$character's pose", ''], ["$character's emotion", ''],
                ['current location', ''],
            ],
            utilityBot: false, customscript: [], exampleMessage: '',
            creatorNotes: '', systemPrompt: '', postHistoryInstructions: '',
            alternateGreetings: [], tags: [], creator: '', characterVersion: '',
            personality: '', scenario: '', firstMsgIndex: -1,
            replaceGlobalNote: '', additionalText: '',
            triggerscript: [
                {
                    comment: '', type: 'manual', conditions: [],
                    effect: [{ type: 'v2Header', code: '', indent: 0 }],
                },
                { comment: 'New Event', type: 'manual', conditions: [], effect: [] },
            ],
        };
        for (const [key, value] of Object.entries(defaults)) {
            if (char[key] === undefined || char[key] === null) char[key] = value;
        }
        char.firstMsgIndex = -1;
        if (!Array.isArray(char.chats) || char.chats.length === 0) {
            char.chats = [{ message: [], note: '', name: 'Chat 1', localLore: [] }];
        }
        char.desc =
            `[Cold storage restore failed. Original key: ${coldKey}]\n\n${char.desc || ''}`.trim();
        delete char.coldstorage;
        delete char.coldStoragedChats;
    }

    function restoreColdStorageCharactersInDb(dbObj) {
        const result = { restored: 0, failed: 0, failedNames: [] };
        if (!Array.isArray(dbObj?.characters)) return result;
        for (let i = 0; i < dbObj.characters.length; i++) {
            const char = dbObj.characters[i];
            if (!char?.coldstorage) continue;
            if (restoreColdStorageCharacter(char)) {
                result.restored++;
            } else {
                result.failed++;
                result.failedNames.push(char.name || `(index ${i})`);
                promoteFailedColdStorageStub(char);
            }
        }
        return result;
    }

    function restoreColdPluginStorageInDb(dbObj) {
        const result = { restored: 0, failed: 0, failedKeys: [] };
        const storage = dbObj?.pluginCustomStorage;
        const coldPluginMap = storage?._coldplugin;
        if (!storage || typeof storage !== 'object' || Array.isArray(storage)
            || !coldPluginMap || typeof coldPluginMap !== 'object'
            || Array.isArray(coldPluginMap)) {
            return result;
        }

        const remaining = [];
        for (const [key, coldId] of Object.entries(coldPluginMap)) {
            let entry = null;
            try {
                if (typeof coldId === 'string' && coldId) {
                    entry = readColdStorageJsonEntry(coldId, { migrateLegacy: true });
                }
            } catch (error) {
                logger.error(
                    `[ColdStorage] plugin storage key "${key}" (${coldId}) could not be read:`,
                    error.message,
                );
            }

            if (!entry) {
                remaining.push([key, coldId]);
                result.failed++;
                result.failedKeys.push(key);
                continue;
            }

            Object.defineProperty(storage, key, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: entry.coldData,
            });
            result.restored++;
        }

        if (remaining.length > 0) {
            storage._coldplugin = Object.fromEntries(remaining);
        } else {
            delete storage._coldplugin;
        }
        return result;
    }

    function restoreColdStorageInDb(dbObj) {
        const pluginStorage = restoreColdPluginStorageInDb(dbObj);
        const characters = restoreColdStorageCharactersInDb(dbObj);
        for (const character of Array.isArray(dbObj?.characters) ? dbObj.characters : []) {
            for (const chat of Array.isArray(character?.chats) ? character.chats : []) {
                if (!restoreColdStorageChat(chat)) {
                    throw new Error(
                        `Cold storage chat restore failed for ${character?.chaId ?? 'unknown'}/${chat?.id ?? 'unknown'}`,
                    );
                }
            }
        }
        return {
            restored: pluginStorage.restored + characters.restored,
            failed: pluginStorage.failed + characters.failed,
            pluginStorage,
            characters,
        };
    }

    function restoreColdStorageChat(chat) {
        if (!chat?.message?.[0]?.data?.startsWith(COLD_STORAGE_HEADER)) return true;
        const key = chat.message[0].data.slice(COLD_STORAGE_HEADER.length);
        const entry = readColdStorageJsonEntry(key, { migrateLegacy: true });
        if (!entry) {
            logger.error(`[ColdStorage] data not found for key: ${key}`);
            return false;
        }
        try {
            const coldData = entry.coldData;
            if (Array.isArray(coldData)) {
                chat.message = coldData;
            } else if (coldData?.message) {
                chat.message = coldData.message;
                if (coldData.hypaV3Data) chat.hypaV3Data = coldData.hypaV3Data;
                if (coldData.scriptstate) chat.scriptstate = coldData.scriptstate;
                if (coldData.localLore) chat.localLore = coldData.localLore;
            }
            chat.lastDate = Date.now();
            return true;
        } catch (error) {
            logger.error(`[ColdStorage] restore failed for key ${key}:`, error.message);
            return false;
        }
    }

    return {
        normalizeColdStorageStorageKey,
        parseColdStorageJsonBuffer,
        encodeColdStorageCanonicalBuffer,
        normalizeColdStorageBackupBuffer,
        readColdStorageJsonEntry,
        listColdStorageBackupEntries,
        restoreColdStorageInDb,
        restoreColdStorageChat,
    };
}

module.exports = {
    createLegacyRestoreService,
};

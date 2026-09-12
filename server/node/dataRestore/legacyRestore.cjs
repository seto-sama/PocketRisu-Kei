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
        readColdStorageJsonEntry,
        listColdStorageBackupEntries,
        restoreColdStorageCharactersInDb,
        restoreColdStorageChat,
    };
}

module.exports = {
    createLegacyRestoreService,
};

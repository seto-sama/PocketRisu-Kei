'use strict';

const {
    removeRuntimeCharacterFields,
    serverOwnedCharacterFields,
    serverOwnedRootFields,
} = require('../persistenceShape.cjs');

/** Apply generation-owned metadata to the same database image as input commit. */
function applyGenerationInputMetadata(database, characterId, now = Date.now()) {
    const character = database?.characters?.find(item => item?.chaId === characterId);
    if (!character) return undefined;

    const currentMessages = Number(database?.statics?.messages);
    database.statics = {
        ...(database.statics && typeof database.statics === 'object' ? database.statics : {}),
        messages: Number.isSafeInteger(currentMessages) && currentMessages >= 0
            ? currentMessages + 1
            : 1,
        imports: Number.isSafeInteger(Number(database?.statics?.imports))
            ? Number(database.statics.imports)
            : 0,
    };
    character.lastInteraction = now;
    removeRuntimeCharacterFields(character);

    return {
        messages: database.statics.messages,
        lastInteraction: now,
    };
}

/**
 * A full browser database write intentionally omits generation-owned fields.
 * Reattach them from the canonical server image before replacing that image.
 */
function restoreGenerationOwnedMetadata(incomingDatabase, currentDatabase) {
    if (!incomingDatabase || typeof incomingDatabase !== 'object') return incomingDatabase;
    if (!currentDatabase || typeof currentDatabase !== 'object') return incomingDatabase;

    for (const [rootKey, fields] of Object.entries(serverOwnedRootFields)) {
        const currentRoot = currentDatabase[rootKey];
        const incomingRoot = incomingDatabase[rootKey];
        const nextRoot = incomingRoot && typeof incomingRoot === 'object'
            ? { ...incomingRoot }
            : {};
        for (const field of fields) {
            if (Object.prototype.hasOwnProperty.call(currentRoot ?? {}, field)) {
                nextRoot[field] = currentRoot[field];
            } else {
                delete nextRoot[field];
            }
        }
        incomingDatabase[rootKey] = nextRoot;
    }

    const currentCharacters = new Map(
        (currentDatabase.characters ?? [])
            .filter(character => typeof character?.chaId === 'string')
            .map(character => [character.chaId, character]),
    );
    for (const incomingCharacter of incomingDatabase.characters ?? []) {
        const currentCharacter = currentCharacters.get(incomingCharacter?.chaId);
        if (!currentCharacter) continue;
        for (const field of serverOwnedCharacterFields) {
            if (Object.prototype.hasOwnProperty.call(currentCharacter, field)) {
                incomingCharacter[field] = currentCharacter[field];
            } else {
                delete incomingCharacter[field];
            }
        }
    }
    return incomingDatabase;
}

module.exports = {
    applyGenerationInputMetadata,
    restoreGenerationOwnedMetadata,
};

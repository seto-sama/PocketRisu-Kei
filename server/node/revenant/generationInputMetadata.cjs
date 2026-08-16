'use strict';

const {
    removeRuntimeCharacterFields,
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

    if (Object.prototype.hasOwnProperty.call(currentDatabase?.statics ?? {}, 'messages')) {
        incomingDatabase.statics = {
            ...(incomingDatabase.statics && typeof incomingDatabase.statics === 'object'
                ? incomingDatabase.statics
                : {}),
            messages: currentDatabase.statics.messages,
        };
    }

    const currentCharacters = new Map(
        (currentDatabase.characters ?? [])
            .filter(character => typeof character?.chaId === 'string')
            .map(character => [character.chaId, character]),
    );
    for (const incomingCharacter of incomingDatabase.characters ?? []) {
        const currentCharacter = currentCharacters.get(incomingCharacter?.chaId);
        if (!currentCharacter) continue;
        if (Object.prototype.hasOwnProperty.call(currentCharacter, 'lastInteraction')) {
            incomingCharacter.lastInteraction = currentCharacter.lastInteraction;
        }
    }
    return incomingDatabase;
}

module.exports = {
    applyGenerationInputMetadata,
    restoreGenerationOwnedMetadata,
};

'use strict';

const persistenceShape = require('../shared/persistenceShape.json');

const nonPersistentCharacterFields = new Set(persistenceShape.legacyCharacterFields);
const serverOwnedCharacterFields = new Set(persistenceShape.serverOwnedCharacterFields);
const serverOwnedRootFields = persistenceShape.serverOwnedRootFields;

function removeRuntimeCharacterFields(character) {
    if (!character || typeof character !== 'object') return character;
    for (const key of nonPersistentCharacterFields) delete character[key];
    return character;
}

function characterToPersistentShape(character) {
    return removeRuntimeCharacterFields({ ...character });
}

module.exports = {
    characterToPersistentShape,
    removeRuntimeCharacterFields,
    serverOwnedCharacterFields,
    serverOwnedRootFields,
};

'use strict';

const runtimeOnlyCharacterFields = new Set(['reloadKeys']);

function removeRuntimeCharacterFields(character) {
    if (!character || typeof character !== 'object') return character;
    for (const key of runtimeOnlyCharacterFields) delete character[key];
    return character;
}

function characterToPersistentShape(character) {
    return removeRuntimeCharacterFields({ ...character });
}

module.exports = {
    characterToPersistentShape,
    removeRuntimeCharacterFields,
};

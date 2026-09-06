/**
 * @typedef {{ keys: Record<string, string>, characters: Array<{id: string | null, hash: string}> }} PatchHashDiagnostics
 */

/** Hash the already-normalized request projection, never raw chat bodies.
 * @param {any} database
 * @param {(value: any) => number} calculateHash
 * @returns {PatchHashDiagnostics}
 */
export function createPatchHashDiagnostics(database, calculateHash) {
    return {
        keys: Object.fromEntries(Object.entries(database).map(([key, value]) =>
            [key, calculateHash(value).toString(16)])),
        // An array preserves duplicate/missing ids and order without collisions
        // with imported ids such as "__proto__" or "#0".
        characters: (database.characters ?? []).map(character => ({
            id: typeof character?.chaId === 'string' ? character.chaId : null,
            hash: calculateHash(character).toString(16),
        })),
    };
}

/** @returns {value is PatchHashDiagnostics} */
export function isPatchHashDiagnostics(value) {
    return value !== null && typeof value === 'object'
        && value.keys !== null && typeof value.keys === 'object' && !Array.isArray(value.keys)
        && Object.values(value.keys).every(hash => typeof hash === 'string')
        && Array.isArray(value.characters)
        && value.characters.every(row => row && (row.id === null || typeof row.id === 'string')
            && typeof row.hash === 'string');
}

/** @param {PatchHashDiagnostics} local @param {PatchHashDiagnostics} server */
export function comparePatchHashDiagnostics(local, server) {
    const ownHash = (hashes, key) => Object.hasOwn(hashes, key) ? hashes[key] : null;
    const keys = [...new Set([...Object.keys(local.keys), ...Object.keys(server.keys)])]
        .filter(key => ownHash(local.keys, key) !== ownHash(server.keys, key))
        .map(key => ({ key, local: ownHash(local.keys, key), server: ownHash(server.keys, key) }));
    const indexCharacters = rows => {
        const occurrences = new Map();
        const indexed = new Map();
        rows.forEach((row, index) => {
            const occurrence = occurrences.get(row.id) ?? 0;
            occurrences.set(row.id, occurrence + 1);
            indexed.set(JSON.stringify([row.id, occurrence]), { ...row, index, occurrence });
        });
        return indexed;
    };
    const ours = indexCharacters(local.characters), theirs = indexCharacters(server.characters);
    const characters = [...new Set([...ours.keys(), ...theirs.keys()])].flatMap(key => {
        const left = ours.get(key), right = theirs.get(key);
        if (left?.hash === right?.hash && left?.index === right?.index) return [];
        return [{
            id: (left ?? right).id, occurrence: (left ?? right).occurrence,
            localIndex: left?.index ?? null, serverIndex: right?.index ?? null,
            local: left?.hash ?? null, server: right?.hash ?? null,
        }];
    });
    return { keys, characters };
}

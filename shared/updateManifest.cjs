'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST_NAME = '.installed-manifest';

function createUpdateManifest(root, newEntries) {
    const manifestPath = path.join(root, MANIFEST_NAME);
    let oldEntries = null;
    try {
        oldEntries = new Set(fs.readFileSync(manifestPath, 'utf8')
            .split('\n').map(entry => entry.trim()).filter(Boolean));
    } catch { /* pre-manifest install */ }
    const incoming = new Set(newEntries);
    const managed = new Set([...incoming, ...(oldEntries || [])]);

    return {
        isManaged: entry => managed.has(entry),
        // Without a previous manifest, ownership of an incoming name is unknown.
        isConflict: entry => oldEntries !== null && !oldEntries.has(entry) && incoming.has(entry),
        conflictDestination(entry, version) {
            const conflictDir = path.join(root, 'backups', `update-conflict-${version}`);
            let dest = path.join(conflictDir, entry);
            for (let n = 1; fs.existsSync(dest); n++) dest = path.join(conflictDir, `${entry}.${n}`);
            return dest;
        },
    };
}

module.exports = { MANIFEST_NAME, createUpdateManifest };

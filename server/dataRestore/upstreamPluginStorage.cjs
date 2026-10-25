'use strict';

const RESERVED_KEYS = ['_coldpluginIndex', '_coldplugin'];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

function resolveUpstreamPluginStorage(storage, readCold) {
    const values = new Map();
    const coldIds = new Set();
    const failures = [];
    const entries = new Map();
    const fail = (key, error) => failures.push({ key, reason: String(error?.message || error) });
    const remember = id => {
        if (typeof id === 'string' && id) coldIds.add(id);
    };

    if (hasOwn(storage, '_coldpluginIndex')) {
        const pointer = storage._coldpluginIndex;
        remember(pointer);
        try {
            if (typeof pointer !== 'string' || !pointer) throw new Error('Invalid plugin storage index pointer');
            const index = readCold(pointer);
            if (!isObject(index) || index.type !== 'risu-plugin-storage-index') {
                throw new Error('Plugin storage index not found or invalid');
            }
            if (index.version !== 1) throw new Error(`Unsupported plugin storage index version ${index.version}`);
            if (!Array.isArray(index.entries) || !Array.isArray(index.trash)) throw new Error('Malformed plugin storage index');
            for (const item of index.trash) remember(item?.id);
            for (const entry of index.entries) {
                remember(entry?.l);
                if (typeof entry?.k !== 'string'
                    || (typeof entry.l !== 'string' && typeof entry.s !== 'string')) {
                    fail(typeof entry?.k === 'string' ? entry.k : '_coldpluginIndex', 'Malformed plugin storage entry');
                    continue;
                }
                // Match upstream's last-entry and large-value precedence.
                entries.set(entry.k, typeof entry.l === 'string' ? { coldId: entry.l } : { json: entry.s });
            }
        } catch (error) {
            fail('_coldpluginIndex', error);
        }
    }

    if (hasOwn(storage, '_coldplugin')) {
        if (!isObject(storage._coldplugin)) {
            fail('_coldplugin', 'Invalid legacy plugin storage map');
        } else {
            for (const [key, id] of Object.entries(storage._coldplugin)) {
                remember(id);
                if (!entries.has(key)) entries.set(key, { coldId: id });
            }
        }
    }

    for (const [key, entry] of entries) {
        if (RESERVED_KEYS.includes(key) || hasOwn(storage, key)) continue;
        try {
            let value;
            if (hasOwn(entry, 'coldId')) {
                if (typeof entry.coldId !== 'string' || !entry.coldId) throw new Error('Invalid plugin storage cold id');
                value = readCold(entry.coldId);
                if (value === undefined) throw new Error('Plugin storage item not found');
            } else {
                value = JSON.parse(entry.json);
            }
            values.set(key, value);
        } catch (error) {
            fail(key, error);
        }
    }

    return { values, coldIds, failures };
}

module.exports = { RESERVED_KEYS, resolveUpstreamPluginStorage };

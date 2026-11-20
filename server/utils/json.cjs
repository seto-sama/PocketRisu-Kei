'use strict';

function normalizeJSON(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') {
        if (typeof value === 'number' && !isFinite(value)) return null;
        if (typeof value === 'function' ||
            typeof value === 'symbol' ||
            typeof value === 'bigint')
            return undefined;
        return value;
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp || value instanceof Error) return {};
    if (Array.isArray(value)) {
        const result = [];
        for (const item of value) {
            if (item === undefined) {
                result.push(null);
            } else {
                const normalized = normalizeJSON(item);
                result.push(normalized === undefined ? null : normalized);
            }
        }
        return result;
    }
    const result = {};
    for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            const propValue = value[key];
            if (propValue !== undefined) {
                const normalized = normalizeJSON(propValue);
                if (normalized !== undefined)
                    result[key] = normalized;
            }
        }
    }
    return result;
}

module.exports = { normalizeJSON };

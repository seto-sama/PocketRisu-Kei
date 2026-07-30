'use strict';

const JOB_TYPES = new Set([
    'model', 'submodel', 'memory', 'emotion', 'otherAx', 'translate',
]);

const OPERATION_JOB_TYPES = Object.freeze({
    translation: 'translate',
    'hypav3-summary': 'memory',
    'lua-llm': 'otherAx',
});

function normalizeRevenantJobType(value) {
    return JOB_TYPES.has(value) ? value : 'model';
}

function isRevenantJobActive(status) {
    return status === 'queued' || status === 'generating';
}

function normalizeRevenantOperationContext(jobType, value) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (typeof value.kind !== 'string' || typeof value.operationId !== 'string') return undefined;
    if (OPERATION_JOB_TYPES[value.kind] !== jobType) return undefined;

    switch (value.kind) {
        case 'translation':
            if (
                typeof value.cacheKey !== 'string'
                || !Array.isArray(value.styleDecodes)
                || !value.styleDecodes.every(item => typeof item === 'string')
                || typeof value.replaceExisting !== 'boolean'
            ) return undefined;
            break;
        case 'hypav3-summary':
            if (
                typeof value.characterId !== 'string'
                || typeof value.roomId !== 'string'
                || !Array.isArray(value.chatMemos)
                || !value.chatMemos.every(item => typeof item === 'string')
            ) return undefined;
            break;
        case 'lua-llm':
            if (
                typeof value.executionKey !== 'string'
                || typeof value.replayKey !== 'string'
                || typeof value.characterId !== 'string'
                || typeof value.roomId !== 'string'
                || typeof value.mode !== 'string'
                || typeof value.code !== 'string'
                || typeof value.lowLevelAccess !== 'boolean'
                || typeof value.anchorMessageId !== 'string'
                || !Number.isInteger(value.callIndex)
            ) return undefined;
            break;
        default:
            return undefined;
    }

    return structuredClone(value);
}

module.exports = {
    isRevenantJobActive,
    normalizeRevenantJobType,
    normalizeRevenantOperationContext,
};

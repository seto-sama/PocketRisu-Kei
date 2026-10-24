'use strict';

const crypto = require('crypto');

function normalizeReplayActionId(rawActionId) {
    const value = String(rawActionId);
    return value.length <= 128
        ? value
        : `${value.slice(0, 94)}.${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function resolveReplayAction(responses, rawActionId, kind, payload) {
    const actionId = normalizeReplayActionId(rawActionId);
    if (Object.prototype.hasOwnProperty.call(responses || {}, actionId)) {
        return { available: true, actionId, value: responses[actionId] };
    }
    return {
        available: false,
        actionId,
        action: { schemaVersion: 1, actionId, kind, payload },
    };
}

module.exports = {
    normalizeReplayActionId,
    resolveReplayAction,
};

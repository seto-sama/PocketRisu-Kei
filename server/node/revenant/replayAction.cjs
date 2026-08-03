'use strict';

const crypto = require('crypto');

const WAITING_CLIENT_PREFIX = 'RISU_REVENANT_WAITING_CLIENT:';

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

function waitingClientError(action) {
    return new Error(WAITING_CLIENT_PREFIX + Buffer.from(JSON.stringify(action)).toString('base64url'));
}

function parseWaitingClientError(error) {
    const message = String(error?.message || error || '');
    const offset = message.indexOf(WAITING_CLIENT_PREFIX);
    if (offset < 0) return undefined;
    const encoded = message.slice(offset + WAITING_CLIENT_PREFIX.length).split(/\s/)[0];
    try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch { return undefined; }
}

module.exports = {
    WAITING_CLIENT_PREFIX,
    normalizeReplayActionId,
    resolveReplayAction,
    waitingClientError,
    parseWaitingClientError,
};

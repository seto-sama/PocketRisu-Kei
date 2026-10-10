'use strict';

const { kvGet, kvSet } = require('../db.cjs');

const LIMIT_KEY = 'config/request-log-max-bytes';
const MIN_REQUEST_LOG_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_LOG_BYTES = 256 * MIN_REQUEST_LOG_BYTES;

function validLimit(value) {
    return Number.isSafeInteger(value) && value >= MIN_REQUEST_LOG_BYTES;
}

function getRequestLogMaxBytes() {
    const raw = kvGet(LIMIT_KEY);
    const value = raw ? Number(Buffer.from(raw).toString('utf8')) : undefined;
    return validLimit(value) ? value : DEFAULT_REQUEST_LOG_BYTES;
}

function setRequestLogMaxBytes(value) {
    if (!validLimit(value)) throw new RangeError('Invalid request log size limit');
    kvSet(LIMIT_KEY, Buffer.from(String(value), 'utf8'));
}

module.exports = { getRequestLogMaxBytes, setRequestLogMaxBytes, MIN_REQUEST_LOG_BYTES };

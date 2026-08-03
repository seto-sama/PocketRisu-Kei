'use strict';

const GENERATION_REQUEST_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const GENERATION_REQUEST_MAX_TIMEOUT_MS = 60 * 60 * 1000;

function normalizeGenerationRequestTimeoutMs(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return GENERATION_REQUEST_DEFAULT_TIMEOUT_MS;
    }
    return Math.min(
        GENERATION_REQUEST_MAX_TIMEOUT_MS,
        Math.max(1, Math.floor(value)),
    );
}

module.exports = {
    GENERATION_REQUEST_DEFAULT_TIMEOUT_MS,
    GENERATION_REQUEST_MAX_TIMEOUT_MS,
    normalizeGenerationRequestTimeoutMs,
};

'use strict';

const codes = require('../../shared/apiErrorCodes.json');
const defaultMessages = require('../../shared/apiErrorMessages.json');

for (const code of Object.values(codes)) {
    if (typeof defaultMessages[code] !== 'string' || !defaultMessages[code]) {
        throw new Error(`Missing default API error message for ${code}`);
    }
}
Object.freeze(defaultMessages);

function apiErrorMessage(code) {
    return defaultMessages[code] || 'Request failed';
}

function createApiError(code, statusCode, details) {
    const error = new Error(apiErrorMessage(code));
    error.code = code;
    error.statusCode = statusCode;
    error.details = details;
    return error;
}

function sendApiError(res, status, code, details) {
    return res.status(status).json({
        error: apiErrorMessage(code),
        code,
        ...(details ? { details } : {}),
    });
}

module.exports = { apiErrorMessage, codes, createApiError, sendApiError };

'use strict';

const BLOCKED_RESPONSE_HEADERS = new Set([
    'cache-control',
    'clear-site-data',
    'content-encoding',
    'content-length',
    'content-security-policy',
    'content-security-policy-report-only',
    'transfer-encoding',
]);

function filterUpstreamResponseHeaders(headers) {
    const filtered = {};
    const entries = typeof headers?.entries === 'function'
        ? headers.entries()
        : Object.entries(headers || {});
    for (const [rawKey, rawValue] of entries) {
        const key = String(rawKey).toLowerCase();
        if (BLOCKED_RESPONSE_HEADERS.has(key) || rawValue === undefined) continue;
        filtered[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    }
    return filtered;
}

async function executeUpstreamRequest(arg, fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(arg.url, {
        method: arg.method,
        headers: arg.headers,
        body: arg.body,
        signal: arg.signal,
        redirect: arg.redirect || 'follow',
    });
    return {
        status: response.status,
        headers: filterUpstreamResponseHeaders(response.headers),
        body: response.body,
    };
}

module.exports = {
    executeUpstreamRequest,
    filterUpstreamResponseHeaders,
};

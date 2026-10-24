'use strict';

function extractRequestModel(body, targetUrl) {
    try {
        const match = new URL(targetUrl).pathname.match(/\/models\/([^:/?]+)/);
        if (match?.[1]) return decodeURIComponent(match[1]).slice(0, 256);
    } catch {}
    try {
        const parsed = JSON.parse(Buffer.from(body || '').toString('utf8'));
        return typeof parsed?.model === 'string' && parsed.model ? parsed.model.slice(0, 256) : null;
    } catch {
        return null;
    }
}

module.exports = { extractRequestModel };

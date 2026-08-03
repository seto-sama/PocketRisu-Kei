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

function abortableTimer(delayMs, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('Aborted'));
    return new Promise((resolve, reject) => {
        const finish = () => {
            signal?.removeEventListener('abort', abort);
            resolve();
        };
        const timer = setTimeout(finish, Math.max(0, delayMs));
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason || new Error('Aborted'));
        };
        signal?.addEventListener('abort', abort, { once: true });
    });
}

/**
 * Local test provider that still uses the ordinary durable generation job.
 * Its OpenAI-compatible wire response is journaled, projected, materialized,
 * cancelled, and recovered by exactly the same lifecycle as a real provider.
 */
async function executeEchoProviderRequest(arg) {
    let input = {};
    try {
        input = JSON.parse(Buffer.from(arg.body || Buffer.alloc(0)).toString('utf-8'));
    } catch {
        // Invalid test input falls back to the documented Echo defaults.
    }
    const message = typeof input.message === 'string' ? input.message : 'Echo Message';
    const model = typeof input.model === 'string' ? input.model : 'Echo';
    const delayMs = Number.isFinite(input.delayMs) ? Math.max(0, input.delayMs) : 0;
    const body = new ReadableStream({
        async start(controller) {
            try {
                if (delayMs > 0) await abortableTimer(delayMs, arg.signal);
                if (arg.signal?.aborted) throw arg.signal.reason || new Error('Aborted');
                controller.enqueue(Buffer.from(JSON.stringify({
                    id: 'echo',
                    object: 'chat.completion',
                    model,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: message },
                        finish_reason: 'stop',
                    }],
                })));
                controller.close();
            } catch (error) {
                controller.error(error);
            }
        },
    });
    return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
    };
}

module.exports = {
    executeEchoProviderRequest,
    executeUpstreamRequest,
    filterUpstreamResponseHeaders,
};

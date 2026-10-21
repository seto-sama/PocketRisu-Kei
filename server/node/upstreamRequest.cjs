'use strict';

const { fetchWithRequestTimeout } = require('../../shared/requestTimeout.mjs');
const { get_encoding } = require('@dqbd/tiktoken');
const { defaults: echoDefaults } = require('../../src/ts/preset/registry/bundled/profiles/developer/echo.json');

let echoTokenizer;

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
    const request = signal => fetchImpl(arg.url, {
        method: arg.method,
        headers: arg.headers,
        body: arg.body,
        signal,
        redirect: arg.redirect || 'follow',
    });
    // Durable generation already owns its deadline; ordinary proxy requests
    // opt into an idle bound without changing that job lifecycle.
    const response = arg.idleTimeoutMs
        ? await fetchWithRequestTimeout(request, { signal: arg.signal, idleTimeoutMs: arg.idleTimeoutMs })
        : await request(arg.signal);
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
    const message = typeof input.message === 'string' ? input.message : echoDefaults.echoMessage;
    const model = typeof input.model === 'string' ? input.model : 'Echo';
    const delayMs = Number.isFinite(input.delayMs) ? Math.max(0, input.delayMs) : 0;
    const streaming = input.stream === true;
    const tokensPerSecond = Number.isFinite(input.tokensPerSecond)
        ? Math.max(1, input.tokensPerSecond) : echoDefaults.echoTokensPerSecond;
    const tokens = streaming
        ? (echoTokenizer ??= get_encoding('o200k_base')).encode(message, [], []) : undefined;
    const body = new ReadableStream({
        async start(controller) {
            try {
                if (delayMs > 0) await abortableTimer(delayMs, arg.signal);
                if (arg.signal?.aborted) throw arg.signal.reason || new Error('Aborted');
                if (streaming) {
                    const decoder = new TextDecoder();
                    const startedAt = Date.now();
                    const emit = (delta, finishReason = null, usage) => controller.enqueue(Buffer.from(
                        `data: ${JSON.stringify({
                            id: 'echo', object: 'chat.completion.chunk', model,
                            choices: [{ index: 0, delta, finish_reason: finishReason }],
                            ...(usage ? { usage } : {}),
                        })}\n\n`,
                    ));
                    for (let index = 0; index < tokens.length; index++) {
                        const remainingMs = startedAt + index * 1000 / tokensPerSecond - Date.now();
                        if (remainingMs > 0) await abortableTimer(remainingMs, arg.signal);
                        if (arg.signal?.aborted) throw arg.signal.reason || new Error('Aborted');
                        const content = decoder.decode(echoTokenizer.decode_single_token_bytes(tokens[index]), { stream: true });
                        emit({ content });
                    }
                    const tail = decoder.decode();
                    if (tail) emit({ content: tail });
                    emit({}, 'stop', { prompt_tokens: 0, completion_tokens: tokens.length, total_tokens: tokens.length });
                    controller.enqueue(Buffer.from('data: [DONE]\n\n'));
                    controller.close();
                    return;
                }
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
        headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
        body,
    };
}

module.exports = {
    executeEchoProviderRequest,
    executeUpstreamRequest,
    filterUpstreamResponseHeaders,
};

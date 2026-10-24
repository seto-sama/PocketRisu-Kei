'use strict';

const { fetchWithRequestTimeout } = require('../shared/requestTimeout.mjs');
const { get_encoding } = require('@dqbd/tiktoken');
const { defaults: echoDefaults } = require('../src/ts/preset/registry/bundled/profiles/developer/echo.json');
const { createOutboundPolicy } = require('./outboundPolicy.cjs');
const defaultOutboundPolicy = createOutboundPolicy();

let echoTokenizer;

const BLOCKED_REQUEST_HEADERS = new Set([
    'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
    'upgrade', 'te', 'trailer', 'cookie', 'cookie2', 'proxy-authorization',
    'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
    'x-forwarded-proto', 'x-node-server-auth', 'x-server-register', 'x-risu-node-path',
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
    'clear-site-data',
    'content-encoding',
    'content-length',
    'content-security-policy',
    'content-security-policy-report-only',
    'transfer-encoding',
    'set-cookie',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'upgrade',
]);

function filterUpstreamRequestHeaders(input) {
    const headers = new Headers(input || {});
    const connectionHeaders = new Set((headers.get('connection') || '').split(',').map(name => name.trim().toLowerCase()));
    for (const name of [...headers.keys()]) {
        if (name.startsWith('risu-') || connectionHeaders.has(name) || BLOCKED_REQUEST_HEADERS.has(name)) headers.delete(name);
    }
    return Object.fromEntries(headers);
}

function filterUpstreamResponseHeaders(headers, { preserveCacheControl = false } = {}) {
    const filtered = {};
    const entries = typeof headers?.entries === 'function'
        ? headers.entries()
        : Object.entries(headers || {});
    for (const [rawKey, rawValue] of entries) {
        const key = String(rawKey).toLowerCase();
        if (BLOCKED_RESPONSE_HEADERS.has(key) || rawValue === undefined) continue;
        if (key === 'cache-control' && !preserveCacheControl) continue;
        filtered[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    }
    return filtered;
}

async function executeHttpRequest(request, { signal, idleTimeoutMs, onClose, filterHeaders }) {
    let closed = false;
    const cleanup = () => {
        if (closed) return;
        closed = true;
        signal?.removeEventListener('abort', cleanup);
        onClose?.();
    };
    if (onClose) signal?.addEventListener('abort', cleanup, { once: true });
    try {
        const response = idleTimeoutMs
            ? await fetchWithRequestTimeout(request, { signal, idleTimeoutMs })
            : await request(signal);
        const reader = onClose ? response.body?.getReader() : undefined;
        const body = reader ? new ReadableStream({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) { cleanup(); controller.close(); }
                    else controller.enqueue(value);
                } catch (error) { cleanup(); controller.error(error); }
            },
            async cancel(reason) {
                try { await reader.cancel(reason); }
                finally { cleanup(); }
            },
        }, { highWaterMark: 0 }) : response.body;
        if (!reader) cleanup();
        return { status: response.status, headers: filterHeaders(response.headers), body };
    } catch (error) {
        cleanup();
        throw error;
    }
}

async function executeUpstreamRequest(arg, fetchImpl = globalThis.fetch) {
    const target = await (arg.outboundPolicy || defaultOutboundPolicy).prepare(arg.url);
    return executeHttpRequest(signal => fetchImpl(target.url, {
        method: arg.method,
        headers: filterUpstreamRequestHeaders(arg.headers),
        body: arg.body,
        signal,
        dispatcher: target.dispatcher,
        redirect: 'error',
    }), {
        signal: arg.signal,
        // Durable generation owns its deadline; proxy requests also bound idle reads.
        idleTimeoutMs: arg.idleTimeoutMs,
        onClose: target.release,
        filterHeaders: filterUpstreamResponseHeaders,
    });
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

// Keep Echo responses on the same job/journal path as network providers.
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
    executeHttpRequest,
    executeEchoProviderRequest,
    executeUpstreamRequest,
    filterUpstreamResponseHeaders,
    filterUpstreamRequestHeaders,
};

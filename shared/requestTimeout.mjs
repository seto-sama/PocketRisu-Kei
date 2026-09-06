export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export function requestIdleTimeoutMs(requestTimeoutMs) {
    return Math.max(DEFAULT_REQUEST_TIMEOUT_MS,
        Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 0);
}

/**
 * Bound response headers and, optionally, pending stream reads. Consumer
 * backpressure is not upstream inactivity. No timer runs between reads.
 * @param {(signal: AbortSignal) => Promise<Response>} request
 * @param {{signal?: AbortSignal | null, firstResponseTimeoutMs?: number, idleTimeoutMs?: number}} options
 * @returns {Promise<Response>}
 */
export async function fetchWithRequestTimeout(request, options = {}) {
    const controller = new AbortController();
    // Keep caller cancellation connected after headers, including when the
    // original response body is returned without an idle limit.
    const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

    async function waitFor(operation, timeoutMs, phase) {
        signal.throwIfAborted();
        let timer;
        let onAbort;
        const aborted = new Promise((_, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            if (timeoutMs > 0) {
                timer = setTimeout(() => controller.abort(new DOMException(
                    `Request ${phase} timed out after ${timeoutMs}ms without data`, 'TimeoutError',
                )), timeoutMs);
            }
        });
        try {
            return await Promise.race([operation(), aborted]);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        }
    }

    const response = await waitFor(async () => {
        const received = await request(signal);
        // Auth preflight and custom fetch implementations may ignore abort.
        // Dispose of a late response rather than leaving an unread connection.
        if (signal.aborted) {
            await received.body?.cancel(signal.reason).catch(() => {});
            throw signal.reason;
        }
        return received;
    }, options.firstResponseTimeoutMs ?? options.idleTimeoutMs, 'first response');

    if (!options.idleTimeoutMs || !response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream({
        async pull(output) {
            try {
                const { done, value } = await waitFor(() => reader.read(), options.idleTimeoutMs, 'stream read');
                if (done) {
                    reader.releaseLock();
                    output.close();
                } else output.enqueue(value);
            } catch (error) {
                output.error(error);
                void reader.cancel(error).catch(() => {});
            }
        },
        cancel(reason) {
            controller.abort(reason);
            return reader.cancel(reason);
        },
    }, { highWaterMark: 0 });
    const wrapped = new Response(body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
    });
    // Wrapping a direct fetch must not erase redirect/CORS metadata exposed to
    // plugins; these fields are not accepted by the Response constructor.
    for (const key of ['url', 'redirected', 'type']) {
        Object.defineProperty(wrapped, key, { value: response[key] });
    }
    return wrapped;
}

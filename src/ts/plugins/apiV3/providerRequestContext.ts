type ProviderResponse = { success: boolean; content: string | ReadableStream<string> }

/** A missing signal is compatible only when there is one active invocation. */
export function resolveProviderRequestContext<T>(contexts: Map<string, T>, token?: string): T | undefined {
    return token !== undefined
        ? contexts.get(token)
        : contexts.size === 1 ? contexts.values().next().value : undefined
}

/** Keep fetch attribution alive for the entire provider response, including streaming. */
export async function withProviderRequestContext<T>(
    contexts: Map<string, T>,
    token: string,
    context: T,
    signal: AbortSignal,
    invoke: () => Promise<ProviderResponse>,
): Promise<ProviderResponse> {
    const cleanup = () => {
        contexts.delete(token)
        signal.removeEventListener('abort', cleanup)
    }
    signal.throwIfAborted()
    contexts.set(token, context)
    signal.addEventListener('abort', cleanup, { once: true })
    let streaming = false
    try {
        const response = await invoke()
        if (response?.content instanceof ReadableStream) {
            const bridge = new TransformStream<string, string>()
            // pipeTo propagates consumer cancellation, source errors and aborts.
            // Both outcomes are handled so background pumping cannot reject unhandled.
            void response.content.pipeTo(bridge.writable, { signal }).then(cleanup, cleanup)
            streaming = true
            return { ...response, content: bridge.readable }
        }
        return response
    } finally {
        if (!streaming) cleanup()
    }
}

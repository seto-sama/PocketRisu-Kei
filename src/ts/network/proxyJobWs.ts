export type ProxyJobWsEvent =
    | { type: 'job_accepted', jobId: string }
    | { type: 'provider_started', startedAt: number }
    | { type: 'upstream_headers', status: number, headers: Record<string, string> }
    | { type: 'chunk', offset?: number, dataBase64: string }
    | { type: 'error', status?: number, message: string }
    | ProxyJobWsDoneEvent
    | { type: 'ping', ts: number };

export interface ProxyJobWsDoneEvent {
    type: 'done'
    /** Durable server state. Older servers omit this field. */
    status?: 'generated' | 'cancelled' | 'interrupted' | 'failed_partial' | 'failed'
    partial?: boolean
    finishReason?: string
}

export function parseProxyJobWsEvent(raw: string): ProxyJobWsEvent | null {
    try {
        const parsed = JSON.parse(raw) as ProxyJobWsEvent;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function decodeProxyJobWsChunk(dataBase64: string): Uint8Array {
    return Buffer.from(dataBase64, 'base64');
}

/** Removes the replayed prefix from an offset-addressed journal chunk. */
export function trimProxyJobWsReplay(
    chunk: Uint8Array,
    chunkOffset: number | undefined,
    receivedBytes: number,
): Uint8Array | null {
    if (chunkOffset === undefined) return chunk
    if (!Number.isSafeInteger(chunkOffset) || chunkOffset < 0 || chunkOffset > receivedBytes) {
        throw new Error(`Proxy journal gap at ${receivedBytes} (chunk starts at ${chunkOffset})`)
    }
    const overlap = receivedBytes - chunkOffset
    if (overlap >= chunk.length) return null
    return overlap > 0 ? chunk.subarray(overlap) : chunk
}

export function formatProxyStreamErrorMessage(status: number | undefined, message: string): string {
    const text = message ?? '';
    if (status === 504 || status === 524 || text.includes('Cloudflare') || text.includes('Gateway time-out') || text.includes('A timeout occurred')) {
        return `Cloudflare/origin timeout (${status ?? 'unknown'}). The origin server did not start sending response in time.`;
    }
    return text || `Proxy stream failed (${status ?? 'unknown'})`;
}

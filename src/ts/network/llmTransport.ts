import { fetchNative } from '../globalApi.svelte'
import type { RevenantGenerationRequest } from '../process/revenantGeneration/types'
import { isLocalNetworkUrl } from './localNetwork'
import {
    SINGLE_LLM_EXECUTION,
    type LLMExecutionPolicy,
} from './transportTypes'

export interface LLMTransportFetchOptions {
    /** Body-interceptor namespace used by plugins and request logging. */
    interceptor: string
    /** Resolve at dispatch time so streaming/workflow metadata is not stale. */
    getGenerationRequest: () => RevenantGenerationRequest | undefined
    /** Resolve at dispatch time so a request cannot silently change durability. */
    getExecutionPolicy?: () => LLMExecutionPolicy
    chatId?: string
    localNetworkTimeoutMs?: number
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.toString()
    return input.url
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
    const source = init?.headers ?? (input instanceof Request ? input.headers : undefined)
    return Object.fromEntries(new Headers(source).entries())
}

/**
 * Creates the only provider-facing fetch implementation used by model
 * adapters. The adapter still sees the standard Fetch API while route,
 * durability, timeout, cancellation, and local-network policy stay centralized.
 */
export function createLLMTransportFetch(options: LLMTransportFetchOptions): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input)
        const method = (init?.method ?? (input instanceof Request ? input.method : 'POST'))
            .toUpperCase() as 'POST' | 'GET' | 'PUT' | 'DELETE'
        const body = init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : undefined)
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        const localNetwork = isLocalNetworkUrl(url)
        const generationRequest = options.getGenerationRequest()
        const executionPolicy = options.getExecutionPolicy?.() ?? SINGLE_LLM_EXECUTION

        return fetchNative(url, {
            method,
            headers: requestHeaders(input, init),
            body: body as string | Uint8Array | ArrayBuffer | undefined,
            signal: signal ?? undefined,
            chatId: options.chatId ?? generationRequest?.job.chatId,
            interceptor: options.interceptor,
            generationRequest,
            llmExecutionPolicy: executionPolicy,
            networkRoute: localNetwork ? 'local_network' : 'auto',
            requestTimeoutMs: localNetwork
                ? (options.localNetworkTimeoutMs ?? 600_000)
                : undefined,
        })
    }) as typeof fetch
}

export type { LLMExecutionPolicy } from './transportTypes'

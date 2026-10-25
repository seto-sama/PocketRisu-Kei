import { createRequestTimeoutSignal } from '../../../shared/requestTimeout.mjs'
import type { RevenantGenerationRequest } from '../process/revenant'
import { bodyIntercepterStore } from '../stores.svelte'
import { readGlobalFetchResponse } from './fetchResult'
import { isLocalNetworkUrl } from './localNetwork'
import { fetchNative } from './nativeFetch'
import { fetchServerProxy } from './proxy'
import type { LLMExecutionPolicy } from './transportTypes'

interface GlobalFetchArgs {
    plainFetchForce?: boolean
    plainFetchDeforce?: boolean
    body?: any
    headers?: Record<string, string>
    rawResponse?: boolean
    method?: 'POST' | 'GET'
    abortSignal?: AbortSignal
    chatId?: string
    generationRequest?: RevenantGenerationRequest
    interceptor?: string
    requestTimeoutMs?: number
    networkRoute?: 'auto' | 'local_network'
    llmExecutionPolicy?: LLMExecutionPolicy
}

interface GlobalFetchResult {
    ok: boolean
    data: any
    headers: Record<string, string>
    status: number
}

// JSON/form callers expect parsed data rather than a Response.
export async function globalFetch(url: string, input: GlobalFetchArgs = {}): Promise<GlobalFetchResult> {
    const arg = { ...input }
    try {
        if (arg.abortSignal?.aborted) return { ok: false, data: 'aborted', headers: {}, status: 400 }

        if (arg.generationRequest && arg.interceptor) {
            const response = await fetchNative(url, {
                body: typeof arg.body === 'string' ? arg.body : JSON.stringify(arg.body),
                headers: arg.headers,
                method: arg.method,
                signal: arg.abortSignal,
                chatId: arg.chatId,
                generationRequest: arg.generationRequest,
                interceptor: arg.interceptor,
                requestTimeoutMs: arg.requestTimeoutMs,
                networkRoute: arg.networkRoute,
                llmExecutionPolicy: arg.llmExecutionPolicy,
            })
            const text = await response.text()
            let data: any = text
            try { data = JSON.parse(text) } catch {}
            return { ok: response.ok, data, headers: Object.fromEntries(response.headers), status: response.status }
        }

        if (arg.interceptor) {
            for (const interceptor of bodyIntercepterStore) {
                try {
                    arg.body = await interceptor.callback(arg.body, arg.interceptor) || arg.body
                } catch (error) {
                    console.error(error)
                }
            }
        }

        const timeout = createRequestTimeoutSignal(arg.abortSignal, arg.requestTimeoutMs)
        try {
            const localNetwork = arg.networkRoute === 'local_network' && isLocalNetworkUrl(url)
            const direct = !localNetwork && !arg.plainFetchDeforce
                && (arg.plainFetchForce || ['localhost', '127.0.0.1', '0.0.0.0'].includes(new URL(url).hostname))
            const method = arg.method ?? 'POST'
            const form = arg.body instanceof URLSearchParams
            const headers = new Headers(arg.headers)
            if (!headers.has('content-type')) {
                headers.set('content-type', form ? 'application/x-www-form-urlencoded' : 'application/json')
            }
            const body = method === 'GET' ? undefined : form ? arg.body.toString() : JSON.stringify(arg.body)
            const options = { method, headers, body, signal: timeout.signal }
            const response = direct
                ? await fetch(url, options)
                : await fetchServerProxy(url, { ...options, requestTimeoutMs: arg.requestTimeoutMs })
            if (direct) {
                const data = arg.rawResponse ? new Uint8Array(await response.arrayBuffer()) : await response.json()
                return { ok: response.ok, data, headers: Object.fromEntries(response.headers), status: response.status }
            }
            return await readGlobalFetchResponse(response, arg.rawResponse)
        } finally {
            timeout.cleanup()
        }
    } catch (error) {
        console.error(error)
        return { ok: false, data: `${error}`, headers: {}, status: 400 }
    }
}

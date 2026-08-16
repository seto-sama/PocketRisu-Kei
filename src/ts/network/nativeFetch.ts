import { isLocalNetworkUrl } from './localNetwork'
import type { LLMExecutionPolicy } from './transportTypes'
import type { RevenantGenerationRequest } from '../process/revenant'
import { fetchViaGenerationJob } from '../process/revenant/transport'
import { DBState, bodyIntercepterStore } from '../stores.svelte'
import { forageStorage } from '../storage/autoStorage'

export interface FetchNativeArgs {
    body?: string | Uint8Array | ArrayBuffer
    headers?: Record<string, string>
    method?: 'POST' | 'GET' | 'PUT' | 'DELETE'
    signal?: AbortSignal
    useRisuTk?: boolean
    chatId?: string
    generationRequest?: RevenantGenerationRequest
    interceptor?: string
    requestTimeoutMs?: number
    networkRoute?: 'auto' | 'local_network'
    llmExecutionPolicy?: LLMExecutionPolicy
}

type NativeFetchLogAdapter = {
    create(entry: Record<string, unknown>): string
    update(id: string, response: unknown, status?: number, success?: boolean): void
}

let logAdapter: NativeFetchLogAdapter | null = null

export function configureNativeFetchLogging(adapter: NativeFetchLogAdapter) {
    logAdapter = adapter
}

function buildTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
    if (!timeoutMs || timeoutMs <= 0) return { signal, cleanup: () => {} }
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    if (signal) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    return { signal: controller.signal, cleanup: () => clearTimeout(timeoutId) }
}

function pipeLoggedResponse(fetchLogId: string, response: Response) {
    if (!response.body) return response
    const [logStream, callerStream] = response.body.tee()
    ;(async () => {
        try {
            logAdapter?.update(fetchLogId, await new Response(logStream).text(), response.status)
        } catch (error) {
            const suppressAbort = response.headers.get('x-risu-revenant-generation') === '1'
                && (
                    (error instanceof DOMException && error.name === 'AbortError')
                    || String(error).includes('AbortError')
                    || String(error).includes('Generation stream detached')
                )
            if (!suppressAbort) logAdapter?.update(fetchLogId, String(error), response.status, false)
        }
    })()
    return new Response(callerStream, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
    })
}

async function createRequiredNodeAuth() {
    const auth = await forageStorage.createAuth()
    if (!auth) throw new Error('Node auth unavailable')
    return auth
}

async function fetchViaProxy2(
    url: string,
    headers: Record<string, string>,
    realBody: Uint8Array | undefined,
    arg: Pick<FetchNativeArgs, 'method' | 'signal' | 'useRisuTk' | 'requestTimeoutMs'>,
) {
    const proxyHeaders: Record<string, string> = {
        'risu-header': encodeURIComponent(JSON.stringify(headers)),
        'risu-url': encodeURIComponent(url),
        'risu-auth': await createRequiredNodeAuth(),
        ...(arg.useRisuTk ? { 'x-risu-tk': 'use' } : {}),
        ...(arg.requestTimeoutMs
            ? { 'risu-timeout-ms': Math.max(1, Math.floor(arg.requestTimeoutMs)).toString() }
            : {}),
        ...(DBState?.db?.requestLocation ? { 'risu-location': DBState.db.requestLocation } : {}),
    }
    if (realBody) {
        proxyHeaders['Content-Type'] = headers['Content-Type']
            ?? headers['content-type']
            ?? 'application/json'
    }
    const response = await fetch('/proxy2', {
        body: realBody as BodyInit,
        headers: proxyHeaders,
        method: arg.method,
        signal: arg.signal,
    })
    return new Response(response.body, { headers: response.headers, status: response.status })
}

export async function fetchNative(url: string, input: FetchNativeArgs): Promise<Response> {
    const arg = { ...input, method: input.method ?? 'POST' } as FetchNativeArgs & {
        method: NonNullable<FetchNativeArgs['method']>
    }
    if (arg.body === undefined && (arg.method === 'POST' || arg.method === 'PUT')) {
        throw new Error('Body is required for POST and PUT requests')
    }

    const headers = arg.headers ?? {}
    let realBody: Uint8Array | undefined
    if (arg.method === 'GET' || arg.method === 'DELETE') {
        realBody = undefined
    } else if (typeof arg.body === 'string') {
        let body = arg.body
        if (arg.interceptor) {
            for (const interceptor of bodyIntercepterStore) {
                try {
                    body = await interceptor.callback(body, arg.interceptor) || body
                } catch (error) {
                    console.error(error)
                }
            }
        }
        realBody = new TextEncoder().encode(body)
    } else if (arg.body instanceof Uint8Array) {
        realBody = arg.body
    } else if (arg.body instanceof ArrayBuffer) {
        realBody = new Uint8Array(arg.body)
    } else {
        throw new Error('Invalid body type')
    }

    let fetchLogId = ''
    const fetchLogBody = realBody ? new TextDecoder().decode(realBody) : ''
    const withFetchLog = (response: Response) => fetchLogId
        ? pipeLoggedResponse(fetchLogId, response)
        : response
    const timeoutSignal = buildTimeoutSignal(arg.signal, arg.requestTimeoutMs)
    const requestSignal = timeoutSignal.signal
    try {
        const revenantRequest = arg.generationRequest
        const useRevenantGenerationJob = !!revenantRequest
            && !!arg.interceptor
            && arg.method === 'POST'
        if (revenantRequest && !arg.llmExecutionPolicy) {
            throw new Error('LLM generation requests require an explicit execution policy')
        }
        if (
            arg.llmExecutionPolicy?.kind === 'workflow'
            && (!revenantRequest?.workflow?.workflowId || !revenantRequest.workflow.stepKey)
        ) {
            throw new Error('Workflow LLM execution requires an active workflow step')
        }
        const durableRequired = arg.llmExecutionPolicy?.durability === 'required'
            || !!revenantRequest?.job.dispatchPolicy
            || !!revenantRequest?.workflow?.dependency
        if (durableRequired && !useRevenantGenerationJob) {
            throw new Error('Durable LLM transport requires a POST request with generation context and interceptor')
        }

        if (useRevenantGenerationJob && durableRequired) {
            try {
                let revenantJobId = ''
                const recordProviderRequest = (startedAt: number) => {
                    if (!revenantJobId || fetchLogId || !logAdapter) return
                    fetchLogId = logAdapter.create({
                        id: revenantJobId,
                        timestamp: startedAt,
                        body: fetchLogBody,
                        header: JSON.stringify(arg.headers ?? {}, null, 2),
                        response: 'Streamed Fetch',
                        responseType: 'stream',
                        success: true,
                        date: new Date(startedAt).toLocaleTimeString(),
                        url,
                        chatId: revenantRequest.job.chatId,
                    })
                }
                return withFetchLog(await fetchViaGenerationJob(url, {
                    method: arg.method,
                    headers,
                    body: realBody,
                    signal: requestSignal,
                    requestTimeoutMs: arg.requestTimeoutMs,
                    generationRequest: revenantRequest,
                    onJobCreated: jobId => {
                        revenantJobId = jobId
                        revenantRequest.lifecycle?.onJobCreated?.(jobId)
                        if (!revenantRequest.job.dispatchPolicy && !revenantRequest.workflow?.dependency) {
                            recordProviderRequest(Date.now())
                        }
                    },
                    onProviderStarted: startedAt => {
                        revenantRequest.lifecycle?.onProviderStarted?.(startedAt)
                        recordProviderRequest(startedAt)
                    },
                    onTerminal: terminal => revenantRequest.lifecycle?.onTerminal?.(terminal),
                }))
            } catch (error) {
                revenantRequest.lifecycle?.onJobRegistrationUnavailable?.(error)
                throw error
            }
        }

        if (arg.llmExecutionPolicy?.providerRoute === 'server') {
            return withFetchLog(await fetchViaProxy2(url, headers, realBody, {
                ...arg,
                signal: requestSignal,
            }))
        }
        if (arg.llmExecutionPolicy?.providerRoute === 'direct') {
            return withFetchLog(await fetch(url, {
                body: realBody as BodyInit,
                headers,
                method: arg.method,
                signal: requestSignal,
            }))
        }
        if (arg.networkRoute === 'local_network' && isLocalNetworkUrl(url)) {
            return withFetchLog(await fetchViaProxy2(url, headers, realBody, {
                ...arg,
                signal: requestSignal,
            }))
        }
        try {
            return withFetchLog(await fetch(url, {
                body: realBody as BodyInit,
                headers,
                method: arg.method,
                signal: requestSignal,
            }))
        } catch (error) {
            if (requestSignal?.aborted) throw error
            return withFetchLog(await fetchViaProxy2(url, headers, realBody, {
                ...arg,
                signal: requestSignal,
            }))
        }
    } finally {
        timeoutSignal.cleanup()
    }
}

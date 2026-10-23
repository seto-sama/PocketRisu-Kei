import { PROXY_PATH } from '../../../shared/proxy.mjs'
import { fetchWithRequestTimeout, requestIdleTimeoutMs } from '../../../shared/requestTimeout.mjs'
import { forageStorage } from '../storage/autoStorage'

export { PROXY_PATH, REALM_PROXY_PATH, getRealmProxyUrl } from '../../../shared/proxy.mjs'

interface ServerProxyOptions {
    method?: string
    headers?: HeadersInit
    body?: string | Uint8Array | ArrayBuffer
    signal?: AbortSignal
    requestTimeoutMs?: number
}

export function fetchServerProxy(url: string, options: ServerProxyOptions): Promise<Response> {
    return fetchWithRequestTimeout(async signal => {
        const auth = await forageStorage.createAuth()
        if (!auth) throw new Error('Node auth unavailable')
        signal.throwIfAborted()
        const method = (options.method ?? 'POST').toUpperCase()
        const body = method === 'GET' || method === 'HEAD' ? undefined : options.body
        return fetch(PROXY_PATH, {
            method,
            body: body as BodyInit,
            signal,
            headers: {
                'risu-url': encodeURIComponent(url),
                'risu-header': encodeURIComponent(JSON.stringify(Object.fromEntries(new Headers(options.headers)))),
                'risu-auth': auth,
                ...(body !== undefined ? { 'Content-Type': 'application/octet-stream' } : {}),
                ...(options.requestTimeoutMs
                    ? { 'risu-timeout-ms': String(Math.max(1, Math.floor(options.requestTimeoutMs))) }
                    : {}),
            },
        })
    }, { signal: options.signal, idleTimeoutMs: requestIdleTimeoutMs(options.requestTimeoutMs) })
}

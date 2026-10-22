import { COMFY_HTTP_ROUTES, createComfyUrl } from 'src/ts/network/comfyUrl'

export interface PluginNetworkPolicyOptions {
    keiUrl: string
    comfyUrls: readonly string[]
    providerActive: boolean
    method?: string
}

const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])

function parseHttpUrl(input: string, base?: string): URL {
    const url = new URL(input, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Plugin network requests must use HTTP or HTTPS')
    }
    if (url.username || url.password) {
        throw new Error('Plugin network request URLs cannot contain credentials')
    }
    return url
}

function isComfyBridgeRequest(url: URL, baseUrl: string, method: string): boolean {
    try {
        return COMFY_HTTP_ROUTES.some(([path, expectedMethod]) => {
            if (method !== expectedMethod) return false
            const endpoint = createComfyUrl(baseUrl, path)
            return url.origin === endpoint.origin
                && url.pathname === endpoint.pathname
        })
    } catch {
        return false
    }
}

/** Authorize and route a host fetch using the same parsed destination. */
export function authorizePluginRequest(
    input: string,
    options: PluginNetworkPolicyOptions,
): { url: string, useServer: boolean } {
    if (typeof input !== 'string' || input.length === 0) {
        throw new Error('Plugin network request URL is required')
    }
    const kei = parseHttpUrl(options.keiUrl)
    const url = parseHttpUrl(input, kei.href)
    const method = (options.method ?? 'GET').toUpperCase()
    if (!allowedMethods.has(method)) throw new Error(`Plugin network method ${method} is not allowed`)

    if (url.origin === kei.origin) {
        if ((method === 'GET' || method === 'HEAD') && /^\/assets\/.+/.test(url.pathname)) {
            return { url: url.href, useServer: false }
        }
        throw new Error('Plugin requests to Kei are limited to read-only assets')
    }

    if (!options.providerActive && options.comfyUrls.some(baseUrl => isComfyBridgeRequest(url, baseUrl, method))) {
        return { url: url.href, useServer: false }
    }
    // Public egress and configured private endpoints are checked by the server,
    // including discovery, auth and updates outside an active provider call.
    return { url: url.href, useServer: true }
}

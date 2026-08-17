export interface PluginProviderFetchOptions {
    method?: string
    body?: unknown
    headers?: unknown
}

export interface PluginProviderFetchClassification {
    generation: boolean
    adapterKind?: string
    streaming?: boolean
}

function requestBodyText(body: unknown): string | undefined {
    if (typeof body === 'string') return body
    if (body instanceof Uint8Array) return new TextDecoder().decode(body)
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
    if (!body || typeof body !== 'object') return undefined
    try {
        return JSON.stringify(body)
    } catch {
        return undefined
    }
}

function requestBodyObject(body: unknown, text: string | undefined): Record<string, unknown> | undefined {
    if (body && typeof body === 'object' && !Array.isArray(body)
        && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
        return body as Record<string, unknown>
    }
    if (!text) return undefined
    try {
        const parsed: unknown = JSON.parse(text)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined
    } catch {
        return undefined
    }
}

function requestUrl(url: string): { hostname: string, pathname: string } {
    try {
        const parsed = new URL(url, 'https://plugin.invalid')
        return {
            hostname: parsed.hostname.toLowerCase(),
            pathname: parsed.pathname.toLowerCase(),
        }
    } catch {
        return { hostname: '', pathname: url.toLowerCase().split('?')[0] }
    }
}

function requestHeaders(headers: unknown): Record<string, string> {
    try {
        return Object.fromEntries(new Headers(headers as HeadersInit).entries())
    } catch {
        return {}
    }
}

function isGenerationEndpoint(pathname: string): boolean {
    return /\/(?:chat\/completions|completions|responses|messages|converse|converse-stream|predictions)\/?$/.test(pathname)
        || /:(?:generatecontent|streamgeneratecontent)$/.test(pathname)
        || /\/(?:invoke|invoke-with-response-stream)\/?$/.test(pathname)
        || /\/(?:api\/)?(?:chat|generate|generate-stream)\/?$/.test(pathname)
}

function isAncillaryEndpoint(pathname: string): boolean {
    return /\/(?:oauth2?|openid-connect)(?:\/|$)/.test(pathname)
        || /\/(?:token|tokens)(?:\/|$)/.test(pathname)
        || /\/cachedcontents(?:\/|$)/.test(pathname)
        || /:(?:counttokens)$/.test(pathname)
        || /\/(?:count_tokens|embeddings|models|moderations)(?:\/|$)/.test(pathname)
}

function hasGenerationBodyShape(body: Record<string, unknown> | undefined): boolean {
    if (!body) return false
    if (Array.isArray(body['messages']) || Array.isArray(body['contents'])) return true
    if (Array.isArray(body['instances'])) return true
    if ('input' in body && ('model' in body || 'instructions' in body || 'tools' in body)) return true
    return 'prompt' in body && ('model' in body || 'parameters' in body || 'max_tokens' in body)
}

function inferAdapterKind(
    hostname: string,
    pathname: string,
    body: Record<string, unknown> | undefined,
    headers: Record<string, string>,
): string {
    if (
        hostname.includes('bedrock-runtime')
        || pathname.includes('invoke-with-response-stream')
        || headers['content-type']?.includes('application/vnd.amazon.eventstream')
    ) return 'amazon-bedrock'
    if (
        pathname.endsWith(':generatecontent')
        || pathname.endsWith(':streamgeneratecontent')
        || Array.isArray(body?.['contents'])
    ) return 'google-gemini'
    if (
        pathname.endsWith('/messages')
        || headers['anthropic-version'] !== undefined
    ) return 'anthropic-messages'
    if (
        pathname.endsWith('/responses')
        || ('input' in (body ?? {}) && !Array.isArray(body?.['messages']))
    ) return 'openai-responses'
    return 'openai-compatible'
}

/**
 * Classifies an existing API 3 provider's fetch without changing the public
 * plugin contract. Workflow dependencies are exact: only the request that
 * still carries the deferred prompt placeholder may inherit them. Ordinary
 * providers fall back to wire endpoint/body semantics so auth, model-list,
 * cache, and usage calls remain normal network requests.
 */
export function classifyPluginProviderFetch(
    url: string,
    options: PluginProviderFetchOptions | undefined,
    workflowDependencyPlaceholder?: string,
): PluginProviderFetchClassification {
    const method = (options?.method ?? (options?.body === undefined ? 'GET' : 'POST')).toUpperCase()
    if (method !== 'POST') return { generation: false }

    const text = requestBodyText(options?.body)
    const body = requestBodyObject(options?.body, text)
    const { hostname, pathname } = requestUrl(url)
    const headers = requestHeaders(options?.headers)
    const generation = workflowDependencyPlaceholder
        ? text?.includes(workflowDependencyPlaceholder) === true
        : isGenerationEndpoint(pathname)
            || (!isAncillaryEndpoint(pathname) && hasGenerationBodyShape(body))

    if (!generation) return { generation: false }

    const streaming = body?.['stream'] === true
        || pathname.endsWith(':streamgeneratecontent')
        || pathname.endsWith('/invoke-with-response-stream')
        || headers['accept']?.includes('text/event-stream') === true
        || headers['accept']?.includes('application/vnd.amazon.eventstream') === true
    return {
        generation: true,
        adapterKind: inferAdapterKind(hostname, pathname, body, headers),
        streaming,
    }
}

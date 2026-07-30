import type { RegistryAuth } from '../types'
import { ModelPresetAdapterError } from './error'
import type { AdapterCredential, AdapterPreparedRequest } from './types'

export function applyAuth(
    prepared: AdapterPreparedRequest,
    auth: RegistryAuth,
    credential: AdapterCredential | undefined,
): AdapterPreparedRequest {
    switch (auth.kind) {
        case 'none':
            return prepared
        case 'bearer': {
            const key = requireApiKey(auth.kind, credential)
            return withHeader(prepared, 'Authorization', `Bearer ${key}`)
        }
        case 'x-api-key': {
            const key = requireApiKey(auth.kind, credential)
            return withHeader(prepared, 'x-api-key', key)
        }
        case 'x-goog-api-key': {
            const key = requireApiKey(auth.kind, credential)
            return withHeader(prepared, 'x-goog-api-key', key)
        }
        case 'query': {
            const key = requireApiKey(auth.kind, credential)
            return { ...prepared, url: appendQuery(prepared.url, 'key', key) }
        }
        case 'google-service-account': {
            // The async `resolveAdapterCredential` step is expected to swap the
            // raw service-account JSON for a freshly-minted access token before
            // this point. We treat it like bearer auth here.
            const token = requireApiKey(auth.kind, credential)
            return withHeader(prepared, 'Authorization', `Bearer ${token}`)
        }
        case 'aws-bedrock':
            // Bedrock API keys use bearer auth, while IAM access keys require
            // an async SigV4 signature over the final serialized request body.
            // Both are applied by the Bedrock adapter after its wire body is
            // complete, so the shared builder intentionally leaves auth alone.
            return prepared
        default: {
            const exhaustiveCheck: never = auth.kind
            throw new ModelPresetAdapterError(
                'unsupported',
                `Unknown auth kind '${exhaustiveCheck as string}'`,
                { retryable: false },
            )
        }
    }
}

function requireApiKey(kind: string, credential: AdapterCredential | undefined): string {
    const key = credential?.apiKey
    if (typeof key !== 'string' || key.length === 0) {
        throw new ModelPresetAdapterError(
            'auth',
            `Auth kind '${kind}' requires an apiKey in credential`,
            { retryable: false },
        )
    }
    return key
}

function withHeader(
    prepared: AdapterPreparedRequest,
    name: string,
    value: string,
): AdapterPreparedRequest {
    const headers: Record<string, string> = {}
    const normalized = name.toLowerCase()
    for (const [existingName, existingValue] of Object.entries(prepared.headers)) {
        if (existingName.toLowerCase() !== normalized) headers[existingName] = existingValue
    }
    headers[name] = value
    return {
        ...prepared,
        headers,
    }
}

export function appendQuery(url: string, key: string, value: string): string {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

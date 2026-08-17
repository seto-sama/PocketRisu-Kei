import { ModelPresetAdapterError } from './error'

export const CLOUDFLARE_ACCOUNT_ID_KEY = 'cloudflareAccountId'
export const CLOUDFLARE_CUSTOM_PATH_ACCOUNT_ID = 'cloudflareAccountId'
export const CLOUDFLARE_GATEWAY_ID_HEADER = 'cf-aig-gateway-id'

/** Convert catalog aliases to the model IDs accepted by Cloudflare's AI API. */
export function normalizeCloudflareAiModelId(modelId: string): string {
    const withoutWorkersAlias = modelId.replace(/^workers-ai\/(?=@cf\/)/u, '')
    return withoutWorkersAlias.replace(
        /^(anthropic\/claude-[a-z][a-z-]*-\d+)-(\d+)(?=$|-)/iu,
        '$1.$2',
    )
}

/**
 * Builds one of Cloudflare's unified AI REST endpoints. The same `/ai/v1` API
 * is used by Workers AI and AI Gateway. Gateway profiles provide the default
 * `cf-aig-gateway-id` header through their profile template.
 */
export function buildCloudflareAiEndpointUrl(
    accountId: string | undefined,
    path = 'chat/completions',
): string {
    const account = sanitizeId(accountId, 'Account ID')
    const endpointPath = path.replace(/^\/+|\/+$/gu, '') || 'chat/completions'
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/v1/${endpointPath}`
}

function sanitizeId(value: string | undefined, label: string): string {
    const trimmed = value?.trim()
    if (!trimmed) {
        throw new ModelPresetAdapterError(
            'invalid-request',
            `Cloudflare ${label} is required`,
            { retryable: false, fallbackEligible: false },
        )
    }
    return trimmed
}

import { ModelPresetAdapterError } from './error'

export const CLOUDFLARE_ACCOUNT_ID_KEY = 'cloudflareAccountId'
export const CLOUDFLARE_CUSTOM_PATH_ACCOUNT_ID = 'cloudflareAccountId'
export const CLOUDFLARE_GATEWAY_ID_HEADER = 'cf-aig-gateway-id'

/**
 * Builds Cloudflare's OpenAI-compatible Chat Completions endpoint. The same
 * `/ai/v1` API is used by Workers AI and AI Gateway. Gateway profiles provide
 * the default `cf-aig-gateway-id` header through their profile template.
 */
export function buildCloudflareAiEndpointUrl(accountId: string | undefined): string {
    const account = sanitizeId(accountId, 'Account ID')
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/v1/chat/completions`
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

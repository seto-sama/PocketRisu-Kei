import {
    extractErrorMessage,
    ModelPresetAdapterError,
    normalizeHttpStatus,
    parseRetryAfterMs,
} from '../error'
import { type ParsedServiceAccount } from './serviceAccount'

export interface ExchangeServiceAccountInput {
    serviceAccount: ParsedServiceAccount
    scope?: string
    now?: () => number
    abortSignal?: AbortSignal
}

export interface AccessTokenResult {
    accessToken: string
    tokenType: string
    expiresInSeconds: number
    issuedAtMs: number
}

export async function parseAccessTokenResponse(
    response: Response,
    issuedAtMs: number,
): Promise<AccessTokenResult> {
    const bodyText = await response.text().catch(() => '')

    const httpError = normalizeHttpStatus(
        response.status,
        extractErrorMessage(bodyText) ?? `HTTP ${response.status}`,
        { retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) },
    )
    if (httpError) {
        throw httpError
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(bodyText)
    } catch (err) {
        throw new ModelPresetAdapterError(
            'parse',
            'OAuth token response is not valid JSON',
            { retryable: true, fallbackEligible: true, cause: err },
        )
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ModelPresetAdapterError(
            'parse',
            'OAuth token response must be a JSON object',
            { retryable: true, fallbackEligible: true },
        )
    }

    const obj = parsed as Record<string, unknown>
    const accessToken = obj.access_token
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new ModelPresetAdapterError(
            'parse',
            "OAuth token response is missing 'access_token'",
            { retryable: false, fallbackEligible: false },
        )
    }
    const expiresInRaw = obj.expires_in
    const expiresInSeconds =
        typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0
            ? Math.floor(expiresInRaw)
            : 0
    if (expiresInSeconds === 0) {
        throw new ModelPresetAdapterError(
            'parse',
            "OAuth token response is missing or invalid 'expires_in'",
            { retryable: false, fallbackEligible: false },
        )
    }
    const tokenTypeRaw = obj.token_type
    const tokenType = typeof tokenTypeRaw === 'string' && tokenTypeRaw.length > 0
        ? tokenTypeRaw
        : 'Bearer'

    return {
        accessToken,
        tokenType,
        expiresInSeconds,
        issuedAtMs,
    }
}

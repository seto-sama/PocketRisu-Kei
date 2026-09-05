import {
    extractErrorMessage,
    ModelPresetAdapterError,
    normalizeFetchError,
    normalizeHttpStatus,
    parseRetryAfterMs,
} from '../error'
import { DEFAULT_SCOPE, type ParsedServiceAccount } from './serviceAccount'

// JWT signing + Google OAuth exchange run on the Node server, not the browser:
// crypto.subtle needs a Secure Context (HTTPS/localhost) which NodeOnly's HTTP
// remote-access pattern does not provide, and node:crypto isn't available in
// the client bundle. The client forwards the service account JSON to this
// endpoint (auth-gated) and the server returns Google's token response verbatim
// so the status/error mapping below is unchanged.
const TOKEN_ENDPOINT = '/api/model-preset/google-service-account/token'

export interface ExchangeServiceAccountInput {
    serviceAccount: ParsedServiceAccount
    scope?: string
    now?: () => number
    fetchImpl?: typeof fetch
    // Returns the `risu-auth` JWT for the NodeOnly server. Defaults to the app's
    // shared session auth; injected in tests to avoid pulling in globalApi.
    getAuthHeader?: () => Promise<string>
    abortSignal?: AbortSignal
}

export interface AccessTokenResult {
    accessToken: string
    tokenType: string
    expiresInSeconds: number
    issuedAtMs: number
}

async function defaultAuthHeader(): Promise<string> {
    const { createStorageAuth } = await import('../../../storage/auth')
    return createStorageAuth()
}

export async function exchangeServiceAccountForAccessToken(
    input: ExchangeServiceAccountInput,
): Promise<AccessTokenResult> {
    const now = input.now ?? Date.now
    const issuedAtMs = now()
    const scope = input.scope && input.scope.length > 0 ? input.scope : DEFAULT_SCOPE

    const fetchImpl = input.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
        throw new ModelPresetAdapterError(
            'unsupported',
            'No fetch implementation available for OAuth token exchange',
            { retryable: false, fallbackEligible: false },
        )
    }

    const authHeader = await (input.getAuthHeader ?? defaultAuthHeader)()

    let response: Response
    try {
        response = await fetchImpl(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'risu-auth': authHeader,
            },
            body: JSON.stringify({ serviceAccountJson: input.serviceAccount.sourceJson, scope }),
            signal: input.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }

    const bodyText = await response.text().catch(() => '')

    // The server forwards Google's token response verbatim (status + body), so
    // a non-2xx maps the same way a direct Google call would.
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

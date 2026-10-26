import {
    ModelPresetAdapterError,
    extractErrorDetails,
    normalizeFetchError,
    normalizeHttpStatus,
    parseRetryAfterMs,
} from './error'
import type { AdapterChatResponse, AdapterPreparedRequest, AdapterResponseDecoder } from './types'
import type { LLMRequestInit } from '../../network/transportTypes'

export interface AdapterHttpTransportOptions {
    fetchImpl?: typeof fetch
    abortSignal?: AbortSignal
}

interface SendPreparedRequestOptions {
    accept?: string
    responseDecoder?: AdapterResponseDecoder
}

export function preparedRequestFetch(prepared: AdapterPreparedRequest, options: AdapterHttpTransportOptions): typeof fetch {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (!prepared.serverProviderAuth) return fetchImpl
    if (!options.fetchImpl) throw new ModelPresetAdapterError('auth', 'Service account requests require server transport')
    return (input, init) => fetchImpl(input, {
        ...init, serverProviderAuth: prepared.serverProviderAuth,
    } satisfies LLMRequestInit)
}

/**
 * Sends the common JSON-body request shape produced by preset adapters.
 *
 * This deliberately stops at the HTTP boundary: provider response parsing and
 * stream event semantics remain in each adapter.
 */
export async function sendPreparedRequest(
    prepared: AdapterPreparedRequest,
    options: AdapterHttpTransportOptions,
    requestOptions: SendPreparedRequestOptions = {},
): Promise<Response> {
    const fetchImpl = preparedRequestFetch(prepared, options)
    const init: LLMRequestInit = {
        method: prepared.method,
        headers: requestOptions.accept
            ? { ...prepared.headers, Accept: requestOptions.accept }
            : prepared.headers,
        body: JSON.stringify(prepared.body),
        signal: options.abortSignal,
        responseDecoder: requestOptions.responseDecoder,
    }
    let response: Response
    try {
        response = await fetchImpl(prepared.url, init)
    } catch (err) {
        throw normalizeFetchError(err)
    }

    if (!response.ok) throw await deriveAdapterHttpError(response)
    return response
}

export async function readResponseText(response: Response): Promise<string> {
    try {
        return await response.text()
    } catch (err) {
        throw normalizeFetchError(err)
    }
}

/** Parses a complete JSON body, labelling malformed provider output. */
export function parseResponseJson(text: string, parseErrorMessage: string): unknown {
    try {
        return JSON.parse(text)
    } catch (err) {
        throw new ModelPresetAdapterError('parse', parseErrorMessage, { cause: err })
    }
}

export async function sendPreparedChatRequest(
    prepared: AdapterPreparedRequest,
    options: AdapterHttpTransportOptions,
    responseDecoder: AdapterResponseDecoder,
    decodeResponse: (body: string, decoder: AdapterResponseDecoder) => AdapterChatResponse,
): Promise<AdapterChatResponse> {
    const response = await sendPreparedRequest(prepared, options, { responseDecoder })
    return decodeResponse(await readResponseText(response), responseDecoder)
}

export async function openPreparedChatStream(
    prepared: AdapterPreparedRequest,
    options: AdapterHttpTransportOptions,
    responseDecoder: AdapterResponseDecoder,
    missingBodyMessage: string,
): Promise<ReadableStream<Uint8Array>> {
    const response = await sendPreparedRequest(prepared, options, {
        accept: 'text/event-stream',
        responseDecoder,
    })
    if (!response.body) {
        throw new ModelPresetAdapterError('parse', missingBodyMessage)
    }
    return response.body
}

export async function deriveAdapterHttpError(
    response: Response,
): Promise<ModelPresetAdapterError> {
    let bodyText = ''
    try {
        bodyText = await response.text()
    } catch {
        // Status alone is enough to classify a failed HTTP response.
    }
    const error = extractErrorDetails(bodyText)
    return normalizeHttpStatus(response.status, error.message ?? undefined, {
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        providerCode: error.code,
    })
        ?? new ModelPresetAdapterError('unknown', error.message ?? `HTTP ${response.status}`, {
            status: response.status,
        })
}

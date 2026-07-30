import {
    ModelPresetAdapterError,
    extractErrorMessage,
    normalizeFetchError,
    normalizeHttpStatus,
} from './error'
import type { AdapterPreparedRequest } from './types'

export interface AdapterHttpTransportOptions {
    fetchImpl?: typeof fetch
    abortSignal?: AbortSignal
}

interface SendPreparedRequestOptions {
    accept?: string
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
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
        response = await fetchImpl(prepared.url, {
            method: prepared.method,
            headers: requestOptions.accept
                ? { ...prepared.headers, Accept: requestOptions.accept }
                : prepared.headers,
            body: JSON.stringify(prepared.body),
            signal: options.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }

    if (!response.ok) throw await deriveAdapterHttpError(response)
    return response
}

export async function sendPreparedJsonRequest(
    prepared: AdapterPreparedRequest,
    options: AdapterHttpTransportOptions,
    parseErrorMessage: string,
): Promise<unknown> {
    const response = await sendPreparedRequest(prepared, options)
    try {
        return await response.json()
    } catch (err) {
        throw new ModelPresetAdapterError('parse', parseErrorMessage, { cause: err })
    }
}

export async function openPreparedEventStream(
    prepared: AdapterPreparedRequest,
    options: AdapterHttpTransportOptions,
    missingBodyMessage: string,
): Promise<ReadableStream<Uint8Array>> {
    const response = await sendPreparedRequest(prepared, options, {
        accept: 'text/event-stream',
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
    const message = extractErrorMessage(bodyText) ?? `HTTP ${response.status}`
    return normalizeHttpStatus(response.status, message)
        ?? new ModelPresetAdapterError('unknown', message, { status: response.status })
}

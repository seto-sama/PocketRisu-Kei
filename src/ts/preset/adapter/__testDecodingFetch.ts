import { decodedChatErrorEvent, encodeDecodedChatEvent, type DecodedChatEvent } from './decodedEvents'
import { decodeAdapterResponseBody } from './responseDecoder'
import type { LLMRequestInit } from '../../network/transportTypes'

/**
 * Test transport that answers the way the server does: a request carrying a
 * responseDecoder receives the decoded events of the provider response, while
 * HTTP errors and requests without a decoder keep the provider body.
 */
export function decodingFetch(fetchImpl: typeof fetch): typeof fetch {
    return async (input, init) => {
        const response = await fetchImpl(input, init)
        const decoder = (init as LLMRequestInit | undefined)?.responseDecoder
        const source = response.body
        if (!decoder || !response.ok || !source) return response
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                const emit = (event: DecodedChatEvent) => controller.enqueue(encoder.encode(encodeDecodedChatEvent(event)))
                void decodeAdapterResponseBody(decoder, source, emit)
                    .catch(error => emit(decodedChatErrorEvent(error)))
                    .finally(() => controller.close())
            },
        })
        return new Response(body, { status: response.status, headers: response.headers })
    }
}

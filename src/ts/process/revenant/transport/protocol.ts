import {
    encodeBinaryMessage, decodeBinaryMessage,
    BINARY_MESSAGE_PREFIX_BYTES, MAX_BINARY_METADATA_BYTES,
} from '../../../network/binaryMessage'
import type { RevenantGenerationTerminal } from '../types'
export {
    BINARY_MESSAGE_CONTENT_TYPE, encodeBinaryMessage, decodeBinaryMessage,
} from '../../../network/binaryMessage'

export const MAX_GENERATION_BODY_BYTES = 6 * 1024 * 1024
export const MAX_GENERATION_REQUEST_BYTES = BINARY_MESSAGE_PREFIX_BYTES
    + MAX_BINARY_METADATA_BYTES + MAX_GENERATION_BODY_BYTES
export const MAX_IMAGE_RESULT_BYTES = 64 * 1024 * 1024
export const MAX_IMAGE_RESULT_MESSAGE_BYTES = BINARY_MESSAGE_PREFIX_BYTES
    + MAX_BINARY_METADATA_BYTES + MAX_IMAGE_RESULT_BYTES

export function encodeGenerationRequest({ body, ...metadata }: Record<string, unknown> & { body?: Uint8Array }) {
    if (body && body.length > MAX_GENERATION_BODY_BYTES) throw new RangeError('Request body too large')
    return encodeBinaryMessage(metadata, body)
}

export function decodeGenerationRequest(message: Uint8Array) {
    const { metadata, bytes } = decodeBinaryMessage(message)
    if (bytes.length > MAX_GENERATION_BODY_BYTES) throw new RangeError('Request body too large')
    return { ...metadata, body: bytes }
}

export function encodeJournalChunk(offset: number, bytes: Uint8Array) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid journal offset')
    return encodeBinaryMessage({ type: 'chunk', offset }, bytes)
}

export function decodeJournalChunk(message: Uint8Array) {
    const { metadata, bytes } = decodeBinaryMessage(message)
    if (metadata.type !== 'chunk' || !Number.isSafeInteger(metadata.offset)
        || (metadata.offset as number) < 0) throw new Error('Invalid journal chunk')
    return { offset: metadata.offset as number, bytes }
}

export type RevenantControlEvent =
    | { type: 'job_accepted', jobId: string }
    | { type: 'provider_started', startedAt: number }
    | { type: 'upstream_headers', status: number, headers: Record<string, string> }
    | { type: 'error', status?: number, message: string }
    | RevenantDoneEvent
    | { type: 'ping', ts: number };

export interface RevenantDoneEvent extends RevenantGenerationTerminal {
    type: 'done'
}

export function parseRevenantControlEvent(raw: string): RevenantControlEvent | null {
    try {
        const parsed = JSON.parse(raw) as RevenantControlEvent;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
            return null;
        }
        switch (parsed.type) {
            case 'job_accepted':
            case 'provider_started':
            case 'upstream_headers':
            case 'error':
            case 'done':
            case 'ping':
                return parsed;
            default:
                return null;
        }
    } catch {
        return null;
    }
}

/** Removes the replayed prefix from an offset-addressed journal chunk. */
export function trimJournalReplay(
    chunk: Uint8Array,
    chunkOffset: number,
    receivedBytes: number,
): Uint8Array | null {
    if (!Number.isSafeInteger(chunkOffset) || chunkOffset < 0 || chunkOffset > receivedBytes) {
        throw new Error(`Generation journal gap at ${receivedBytes} (chunk starts at ${chunkOffset})`)
    }
    const overlap = receivedBytes - chunkOffset
    if (overlap >= chunk.length) return null
    return overlap > 0 ? chunk.subarray(overlap) : chunk
}

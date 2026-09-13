/**
 * A binary message is uint32 BE JSON-byte-length, UTF-8 JSON object, then
 * unmodified payload bytes. HTTP bodies and WS binary messages use the same
 * envelope; WS control-only messages remain ordinary JSON text messages.
 */
export const BINARY_MESSAGE_CONTENT_TYPE = 'application/octet-stream'
export const BINARY_MESSAGE_PREFIX_BYTES = 4
// Matches the existing JSON API metadata limit (prompt/reroll snapshots).
export const MAX_BINARY_METADATA_BYTES = 100 * 1024 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeBinaryMessage(
    metadata: Record<string, unknown>,
    bytes: Uint8Array | Uint8Array[] = new Uint8Array(),
): Uint8Array<ArrayBuffer> {
    const json = encoder.encode(JSON.stringify(metadata))
    if (json.length > MAX_BINARY_METADATA_BYTES) throw new RangeError('Binary metadata too large')
    const parts = Array.isArray(bytes) ? bytes : [bytes]
    const message = new Uint8Array(BINARY_MESSAGE_PREFIX_BYTES + json.length
        + parts.reduce((length, part) => length + part.length, 0))
    new DataView(message.buffer).setUint32(0, json.length)
    message.set(json, BINARY_MESSAGE_PREFIX_BYTES)
    let offset = BINARY_MESSAGE_PREFIX_BYTES + json.length
    for (const part of parts) {
        message.set(part, offset)
        offset += part.length
    }
    return message
}

export function decodeBinaryMessage(message: Uint8Array): {
    metadata: Record<string, unknown>
    bytes: Uint8Array
} {
    if (message.length < BINARY_MESSAGE_PREFIX_BYTES) throw new Error('Truncated binary message')
    const jsonLength = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0)
    if (jsonLength > MAX_BINARY_METADATA_BYTES) throw new RangeError('Binary metadata too large')
    const payloadOffset = BINARY_MESSAGE_PREFIX_BYTES + jsonLength
    if (payloadOffset > message.length) throw new Error('Truncated binary metadata')
    const metadata: unknown = JSON.parse(decoder.decode(message.subarray(BINARY_MESSAGE_PREFIX_BYTES, payloadOffset)))
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Binary metadata must be a JSON object')
    }
    return { metadata: metadata as Record<string, unknown>, bytes: message.subarray(payloadOffset) }
}

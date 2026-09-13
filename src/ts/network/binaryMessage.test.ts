import { describe, expect, it } from 'vitest'
import { decodeBinaryMessage, encodeBinaryMessage, MAX_BINARY_METADATA_BYTES } from './binaryMessage'

describe('JSON metadata with binary payload', () => {
    it('preserves arbitrary bytes, partial UTF-8 and Unicode metadata without text conversion', () => {
        const metadata = { type: 'chunk', offset: 2 ** 40, label: '한글 🌸' }
        const bytes = Uint8Array.of(0, 255, 128, 0xea, 0xb0, 10, 13)
        const encoded = encodeBinaryMessage(metadata, bytes)
        const padded = new Uint8Array(encoded.length + 11)
        padded.set(encoded, 7)
        expect(decodeBinaryMessage(padded.subarray(7, 7 + encoded.length))).toEqual({ metadata, bytes })
        expect(encoded.length).toBe(4 + new TextEncoder().encode(JSON.stringify(metadata)).length + bytes.length)
    })

    it('supports an empty body', () => {
        expect(decodeBinaryMessage(encodeBinaryMessage({ method: 'GET' }))).toEqual({
            metadata: { method: 'GET' }, bytes: new Uint8Array(),
        })
    })

    it('rejects truncated, oversized, invalid UTF-8 and non-object metadata', () => {
        expect(() => decodeBinaryMessage(Uint8Array.of(0, 0))).toThrow('Truncated')
        expect(() => decodeBinaryMessage(Uint8Array.of(0, 0, 0, 8, 123))).toThrow('Truncated')
        const oversized = new Uint8Array(4)
        new DataView(oversized.buffer).setUint32(0, MAX_BINARY_METADATA_BYTES + 1)
        expect(() => decodeBinaryMessage(oversized)).toThrow('too large')
        expect(() => decodeBinaryMessage(Uint8Array.of(0, 0, 0, 1, 255))).toThrow()
        expect(() => decodeBinaryMessage(Uint8Array.of(0, 0, 0, 2, 91, 93))).toThrow('JSON object')
    })
})

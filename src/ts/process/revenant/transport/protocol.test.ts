import { describe, expect, it } from 'vitest'

import {
    parseRevenantControlEvent,
    trimJournalReplay,
    encodeGenerationRequest, decodeGenerationRequest,
    encodeJournalChunk, decodeJournalChunk,
    MAX_GENERATION_BODY_BYTES,
} from './protocol'
import { encodeBinaryMessage } from '../../../network/binaryMessage'

describe('generation binary protocol', () => {
    it('enforces the raw request limit on both sender and receiver', () => {
        const body = new Uint8Array(MAX_GENERATION_BODY_BYTES + 1)
        expect(() => encodeGenerationRequest({ body })).toThrow('Request body too large')
        expect(() => decodeGenerationRequest(encodeBinaryMessage({}, body))).toThrow('Request body too large')
    })

    it('keeps byte offsets above 32 bits and rejects invalid journal envelopes', () => {
        const bytes = Uint8Array.of(255, 128)
        expect(decodeJournalChunk(encodeJournalChunk(2 ** 40, bytes))).toEqual({ offset: 2 ** 40, bytes })
        for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
            expect(() => decodeJournalChunk(encodeBinaryMessage({ type: 'chunk', offset }, bytes))).toThrow('Invalid journal')
        }
        expect(() => decodeJournalChunk(encodeBinaryMessage({ type: 'done', offset: 0 }))).toThrow('Invalid journal')
    })
})

describe('parseRevenantControlEvent', () => {
    it('returns null for invalid input', () => {
        expect(parseRevenantControlEvent('not-json')).toBeNull()
        expect(parseRevenantControlEvent(JSON.stringify({ nope: 1 }))).toBeNull()
        expect(parseRevenantControlEvent(JSON.stringify({ type: 'chunk', offset: 0 }))).toBeNull()
    })
})

describe('trimJournalReplay', () => {
    const bytes = new TextEncoder().encode('abcdefgh')

    it('keeps a chunk that starts at the expected journal offset', () => {
        expect(new TextDecoder().decode(trimJournalReplay(bytes, 4, 4)!)).toBe('abcdefgh')
    })

    it('removes bytes already delivered before a reconnect', () => {
        expect(new TextDecoder().decode(trimJournalReplay(bytes, 4, 7)!)).toBe('defgh')
        expect(trimJournalReplay(bytes, 4, 12)).toBeNull()
    })

    it('rejects a journal gap', () => {
        expect(() => trimJournalReplay(bytes, 8, 7)).toThrow('journal gap')
    })
})

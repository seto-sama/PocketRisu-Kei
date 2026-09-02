import { describe, expect, it } from 'vitest'

import {
    formatProxyStreamErrorMessage,
    parseProxyJobWsEvent,
    trimProxyJobWsReplay,
} from './proxyJobWs'

describe('parseProxyJobWsEvent', () => {
    it('preserves the durable terminal job state', () => {
        expect(parseProxyJobWsEvent(JSON.stringify({
            type: 'done',
            status: 'cancelled',
            partial: true,
            finishReason: 'workflow_cancelled',
        }))).toEqual({
            type: 'done',
            status: 'cancelled',
            partial: true,
            finishReason: 'workflow_cancelled',
        })
    })

    it('returns null for invalid input', () => {
        expect(parseProxyJobWsEvent('not-json')).toBeNull()
        expect(parseProxyJobWsEvent(JSON.stringify({ nope: 1 }))).toBeNull()
    })
})

describe('trimProxyJobWsReplay', () => {
    const bytes = new TextEncoder().encode('abcdefgh')

    it('keeps a chunk that starts at the expected journal offset', () => {
        expect(new TextDecoder().decode(trimProxyJobWsReplay(bytes, 4, 4)!)).toBe('abcdefgh')
    })

    it('removes bytes already delivered before a reconnect', () => {
        expect(new TextDecoder().decode(trimProxyJobWsReplay(bytes, 4, 7)!)).toBe('defgh')
        expect(trimProxyJobWsReplay(bytes, 4, 12)).toBeNull()
    })

    it('rejects a journal gap', () => {
        expect(() => trimProxyJobWsReplay(bytes, 8, 7)).toThrow('journal gap')
    })
})

describe('formatProxyStreamErrorMessage', () => {
    it('maps cloudflare/origin timeout errors to clear message', () => {
        const msg = formatProxyStreamErrorMessage(504, '<!DOCTYPE html><title>Gateway time-out</title>')
        expect(msg).toContain('Cloudflare/origin timeout')
    })

    it('passes through non-timeout messages', () => {
        expect(formatProxyStreamErrorMessage(400, 'bad request')).toBe('bad request')
    })
})

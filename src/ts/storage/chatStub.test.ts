import { describe, test, expect } from 'vitest'
import { isChatStub } from './chatStub'

describe('isChatStub', () => {
    test('accepts a real stub (only _stub + metadata fields)', () => {
        expect(isChatStub({ id: 'c1', name: 'x', _stub: true })).toBe(true)
    })

    // v1.4.x corruption: a real body must never be treated as metadata only.
    test('rejects a hybrid (_stub: true + message array)', () => {
        expect(isChatStub({
            id: 'c1', name: 'x', _stub: true,
            message: [{ role: 'user', data: 'hi' }],
            note: 'leftover',
        })).toBe(false)
    })

    test('rejects when _stub is not strictly true', () => {
        expect(isChatStub({ id: 'c1', name: 'x', _stub: 1 })).toBe(false)
        expect(isChatStub({ id: 'c1', name: 'x', _stub: 'true' })).toBe(false)
        expect(isChatStub({ id: 'c1', name: 'x', _stub: false })).toBe(false)
    })
})

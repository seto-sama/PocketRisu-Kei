import { describe, test, expect } from 'vitest'
import { isChatStub } from './chatStub'

// Direct tests against the production isChatStub. The chat-data-loss bug
// turned on this exact predicate misclassifying "hybrid" objects (legacy
// v1.4.x disk corruption: `_stub: true` riding on a real Chat with message).
// If anyone weakens this check in the future, this suite catches it before
// the patcher starts emitting chat-internal field ops again.

describe('isChatStub (production)', () => {
    test('accepts a real stub (only _stub + metadata fields)', () => {
        expect(isChatStub({ id: 'c1', name: 'x', _stub: true })).toBe(true)
    })

    // Core regression test: the v1.4.x hybrid pattern. Must NOT be a stub.
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

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as guardedDelta from '../shared/guardedDelta.mjs'

const { applyDelta, createDelta, DeltaConflictError, DeltaValidationError } = guardedDelta as any

describe('guarded JSON deltas', () => {
    it('keeps a generated image when a concurrent edit deletes an older message', () => {
        const base = { message: [{ chatId: 'old', data: 'text' }] }
        const edited = { message: [] }
        const changes = createDelta(base, edited)
        const current = { message: [{ chatId: 'old', data: 'text' }, { chatId: 'image', data: 'generated' }] }

        expect(applyDelta(current, changes)).toEqual({
            message: [{ chatId: 'image', data: 'generated' }],
        })
    })

    it('merges edits to different messages and rejects any concurrent edit to one message', () => {
        const base = { message: [
            { chatId: 'one', data: 'old one', role: 'user' },
            { chatId: 'two', data: 'old two', role: 'assistant' },
        ] }
        const edited = structuredClone(base)
        edited.message[0].data = 'new one'
        const changes = createDelta(base, edited)
        const concurrent = structuredClone(base)
        concurrent.message[1].data = 'new two'

        expect(applyDelta(concurrent, changes).message).toEqual([
            { chatId: 'one', data: 'new one', role: 'user' },
            { chatId: 'two', data: 'new two', role: 'assistant' },
        ])

        const sameMessageConcurrent = structuredClone(base)
        sameMessageConcurrent.message[0].role = 'assistant'
        expect(() => applyDelta(sameMessageConcurrent, changes)).toThrow(DeltaConflictError)
    })

    it('merges separate toggle keys but conflicts on a different value for the same key', () => {
        const base = { toggles: { first: 'A', second: 'off' } }
        const edited = { toggles: { first: 'B', second: 'off' } }
        const changes = createDelta(base, edited)

        expect(applyDelta({ toggles: { first: 'A', second: 'on' } }, changes)).toEqual({
            toggles: { first: 'B', second: 'on' },
        })
        expect(() => applyDelta({ toggles: { first: 'C', second: 'off' } }, changes))
            .toThrow(DeltaConflictError)
    })

    it('combines independent keys when both clients create the same settings container', () => {
        const base = {}
        const current = { toggles: { first: 'on' } }
        expect(applyDelta(current, createDelta(base, { toggles: { second: 'on' } }))).toEqual({
            toggles: { first: 'on', second: 'on' },
        })
        expect(() => applyDelta(current, createDelta(base, { toggles: { first: 'off' } })))
            .toThrow(DeltaConflictError)
    })

    it('replays a successfully applied delta after a lost response', () => {
        const base = { prompt: 'before' }
        const changes = createDelta(base, { prompt: 'after' })
        const first = applyDelta(base, changes)

        expect(applyDelta(first, changes)).toEqual(first)
    })

    it('clears a large history while retaining concurrent additions and conflicting on edited deletions', () => {
        const base = { message: Array.from({ length: 2_000 }, (_, index) => ({ chatId: String(index), data: 'before' })) }
        const changes = createDelta(base, { message: [] })
        const image = { chatId: 'image', data: 'new image' }
        const current = { message: [...base.message, image] }
        const edited = { message: base.message.map(message => ({ ...message, data: 'edited' })) }
        expect(applyDelta(current, createDelta(base, edited)).message).toEqual([...edited.message, image])
        const cleared = applyDelta(current, changes)
        expect(cleared).toEqual({ message: [image] })
        expect(applyDelta(cleared, changes)).toEqual(cleared)
        current.message[1] = { ...current.message[1], data: 'concurrent edit' }
        expect(() => applyDelta(current, changes)).toThrow(DeltaConflictError)
        expect(current.message).toHaveLength(2_001)
    })

    it('applies stable-ID deletion, insertion, and reorder while keeping concurrent additions', () => {
        const base = { message: [
            { chatId: 'a', data: 'a' },
            { chatId: 'b', data: 'b' },
            { chatId: 'c', data: 'c' },
        ] }
        const edited = { message: [
            { chatId: 'c', data: 'c' },
            { chatId: 'x', data: 'x' },
            { chatId: 'a', data: 'a' },
        ] }
        const changes = createDelta(base, edited)
        const current = { message: [
            { chatId: 'a', data: 'a' },
            { chatId: 'b', data: 'b' },
            { chatId: 'server', data: 'concurrent' },
            { chatId: 'c', data: 'c' },
        ] }

        expect(applyDelta(current, changes).message.map((message: any) => message.chatId))
            .toEqual(['c', 'server', 'x', 'a'])
    })

    it('leaves the input unchanged when any operation in a batch conflicts', () => {
        const base = { first: 'old', second: 'old' }
        const edited = { first: 'new', second: 'new' }
        const changes = createDelta(base, edited)
        const current = { first: 'server', second: 'old' }
        const original = structuredClone(current)

        expect(() => applyDelta(current, changes)).toThrow(DeltaConflictError)
        expect(current).toEqual(original)
    })

    it('retains the order of adjacent insertions and treats a deleted parent as a conflict', () => {
        const base = { items: [{ id: 'a', value: 1 }] }
        const edited = { items: [...base.items, { id: 'x', value: 2 }, { id: 'y', value: 3 }] }
        expect(applyDelta(base, createDelta(base, edited))).toEqual(edited)
        const modified = { items: [{ id: 'a', value: 2 }] }
        expect(() => applyDelta({ items: [] }, createDelta(base, modified))).toThrow(DeltaConflictError)
    })

    it('addresses characterOrder entries by character ID or folder ID, keeping unseen entries in place', () => {
        const folder = { id: 'f1', name: 'Folder', data: ['b'] }
        const base = { characterOrder: ['a', folder, 'c'] }
        const edited = { characterOrder: ['c', 'new', 'a', { ...folder, data: ['b', 'd'] }] }
        const changes = createDelta(base, edited)
        expect(changes.every((change: any) => change.path.length > 1 || change.kind === 'order')).toBe(true)

        const unseen = { id: 'f2', name: 'Unseen', data: ['z'] }
        expect(applyDelta({ characterOrder: ['a', folder, 'c', unseen] }, changes)).toEqual({
            characterOrder: ['c', 'new', 'a', { ...folder, data: ['b', 'd'] }, unseen],
        })
    })

    it('rejects malformed selectors, identity mismatches, and prototype paths', () => {
        expect(() => applyDelta({}, [{
            kind: 'value', path: [{ key: 'id', value: 3 }],
            before: { exists: false }, after: { exists: true, value: { id: '3' } },
        }])).toThrow(DeltaValidationError)

        expect(() => applyDelta({}, [{
            kind: 'value', path: ['__proto__', 'polluted'],
            before: { exists: false }, after: { exists: true, value: true },
        }])).toThrow(DeltaValidationError)

        expect(() => applyDelta({ items: [] }, [{
            kind: 'value', path: ['items', { key: 'id', value: 'wanted' }],
            before: { exists: false }, after: { exists: true, value: { id: 'other' } },
        }])).toThrow(DeltaValidationError)
        expect(({} as any).polluted).toBeUndefined()
    })
})

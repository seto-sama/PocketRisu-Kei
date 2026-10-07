// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { applyDelta, createDelta } from '../../../shared/guardedDelta.mjs'
import { prepareSaveConflict } from './saveConflict'

describe('save conflict choices', () => {
    it('resolves fields individually and keeps independent changes from both sides', () => {
        const base = { toggles: { a: 'off', b: 'off' }, note: '', serverNote: '' }
        const local = { ...base, toggles: { a: 'mine', b: 'mine' }, note: 'local note' }
        const server = { ...base, toggles: { a: 'server', b: 'server' }, serverNote: 'remote note' }
        const plan = prepareSaveConflict(base, createDelta(base, local), server)
        expect(plan.items.map(item => item.path)).toEqual([['toggles', 'a'], ['toggles', 'b']])
        const resolved = plan.resolve(['server', 'local'])
        expect(resolved).toEqual({ toggles: { a: 'server', b: 'mine' }, note: 'local note', serverNote: 'remote note' })
        expect(applyDelta(server, createDelta(server, resolved))).toEqual(resolved)
    })

    it('supports a deleted message and a parent deleted on the server without discarding other changes', () => {
        const message = { chatId: 'm', data: 'before' }
        const kept = { chatId: 'kept', data: 'unchanged' }, added = { chatId: 'image', data: 'new image' }
        const base = { message: [message, kept], settings: { prompt: 'before' }, note: '' }
        const local = { message: [kept], settings: { prompt: 'mine' }, note: 'local note' }
        const server = { message: [added, { ...message, data: 'remote' }, kept], note: '' }
        const plan = prepareSaveConflict<any>(base, createDelta(base, local), server)
        expect(plan.items).toHaveLength(2)
        expect(plan.resolve(['server', 'local'])).toEqual({ message: server.message, settings: local.settings, note: 'local note' })
        expect(plan.resolve(['local', 'server'])).toEqual({ message: [added, kept], note: 'local note' })
    })

    it('compares a whole message when different fields of that message changed', () => {
        const base = { message: [{ chatId: 'm', data: 'before', translated: 'before' }] }
        const local = { message: [{ ...base.message[0], data: 'mine' }] }
        const server = { message: [{ ...base.message[0], translated: 'server' }] }
        const plan = prepareSaveConflict(base, createDelta(base, local), server)
        expect(plan.items).toHaveLength(1)
        expect(plan.resolve(['server'])).toEqual(server)
        expect(plan.resolve(['local'])).toEqual(local)
    })

    it('resolves concurrent order changes while preserving independent message edits', () => {
        const a = { chatId: 'a', data: 'a' }, b = { chatId: 'b', data: 'b' }, c = { chatId: 'c', data: 'c' }
        const base = { message: [a, b, c] }
        const local = { message: [c, { ...a, data: 'mine' }, b] }
        const server = { message: [b, c, a] }
        const plan = prepareSaveConflict(base, createDelta(base, local), server)
        expect(plan.items.map(item => item.kind)).toEqual(['order'])
        expect(plan.resolve(['server']).message).toEqual([b, c, { ...a, data: 'mine' }])
        expect(plan.resolve(['local']).message).toEqual(local.message)
    })
})

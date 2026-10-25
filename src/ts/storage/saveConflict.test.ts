// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import { applyDelta, createDelta } from '../../../shared/guardedDelta.mjs'
import { language } from 'src/lang'
import {
    chooseConflictComparison,
    chooseSaveConflict,
    prepareSaveConflict,
    SaveConflictCancelledError,
    saveConflictDialog,
    type SaveConflictDialogState,
} from './saveConflict'

function waitForDialog(title: string) {
    return new Promise<SaveConflictDialogState>(resolve => {
        let unsubscribe = () => {}
        unsubscribe = saveConflictDialog.subscribe(state => {
            if (state?.title === title) {
                unsubscribe()
                resolve(state)
            }
        })
    })
}

const comparison = (title: string) => ({
    title,
    items: [{
        label: 'Name',
        blocks: [{
            server: { name: 'Name', type: 'Text', text: 'Server value' },
            local: { name: 'Name', type: 'Text', text: 'Local value' },
        }],
    }],
})

afterEach(() => {
    get(saveConflictDialog)?.complete(null)
})

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

    it('prepares field presentations for the exclusive database resolver', async () => {
        const base = { name: 'Before' }
        const local = { name: 'Mine' }
        const server = { name: 'Theirs' }
        const shown = waitForDialog(language.saveConflict.title)
        const pending = chooseSaveConflict(base, createDelta(base, local), server)
        const state = await shown

        expect(state.multiple).not.toBe(true)
        expect(state.items).toEqual([{
            label: language.name,
            blocks: [{
                server: { name: language.name, type: language.saveConflict.valueTypes.string, text: 'Theirs' },
                local: { name: language.name, type: language.saveConflict.valueTypes.string, text: 'Mine' },
            }],
        }])
        state.complete(['local'])
        await expect(pending).resolves.toEqual(local)
    })

    it('serializes dialogs and an aborted queued request cannot close the active dialog', async () => {
        const firstShown = waitForDialog('First comparison')
        const firstPending = chooseConflictComparison(comparison('First comparison'))
        const first = await firstShown

        const controller = new AbortController()
        const secondPending = chooseConflictComparison(comparison('Second comparison'), controller.signal)
        controller.abort()
        expect(get(saveConflictDialog)).toBe(first)

        first.complete(['local'])
        await expect(firstPending).resolves.toEqual(['local'])
        await expect(secondPending).rejects.toBeInstanceOf(SaveConflictCancelledError)
        expect(get(saveConflictDialog)).toBeNull()
    })

    it('closes its active dialog when its signal aborts and preserves explicit no-side choices', async () => {
        const controller = new AbortController()
        const shown = waitForDialog('Abortable comparison')
        const pending = chooseConflictComparison(comparison('Abortable comparison'), controller.signal)
        const state = await shown
        controller.abort()
        await expect(pending).rejects.toBeInstanceOf(SaveConflictCancelledError)
        expect(get(saveConflictDialog)).toBeNull()

        const nextShown = waitForDialog('Multiple comparison')
        const nextPending = chooseConflictComparison({ ...comparison('Multiple comparison'), multiple: true })
        const next = await nextShown
        next.complete([null])
        await expect(nextPending).resolves.toEqual([null])
    })
})

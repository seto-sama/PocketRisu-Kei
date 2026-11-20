// @vitest-environment node
import { openDatabase } from './sqlite.cjs'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import clipboardStorePkg from './clipboardStore.cjs'

const { createClipboardStore, CLIPBOARD_HISTORY_LIMIT } = clipboardStorePkg as any

const databases: DatabaseSync[] = []

function createStore() {
    const database = openDatabase(':memory:')
    databases.push(database)
    return createClipboardStore(database)
}

const texts = (store: any, options?: { guarded?: boolean }) =>
    store.list(options).entries.map((entry: { text: string }) => entry.text)

afterEach(() => {
    while (databases.length > 0) databases.pop()?.close()
})

describe('Kei clipboard store', () => {
    it('lists newest first and moves a re-copied text to the top', () => {
        const store = createStore()
        store.add('first')
        store.add('second')
        store.add('first')
        expect(texts(store)).toEqual(['first', 'second'])
    })

    it('caps unpinned history, including entries that get unpinned', () => {
        const store = createStore()
        store.add('keep')
        store.setPinned(store.list().entries[0].id, true)
        for (let i = 0; i < CLIPBOARD_HISTORY_LIMIT + 5; i++) store.add(`text-${i}`)
        const entries = store.list().entries
        expect(entries).toHaveLength(CLIPBOARD_HISTORY_LIMIT + 1)
        expect(entries.at(-1)).toMatchObject({ text: 'keep', pinned: true })

        // Unpinning the oldest entry puts it back under the cap, which drops it.
        store.setPinned(entries.at(-1).id, false)
        expect(store.list().entries).toHaveLength(CLIPBOARD_HISTORY_LIMIT)
        expect(texts(store)).not.toContain('keep')

        store.clearUnpinned()
        expect(texts(store)).toEqual([])
    })

    it('hides text copied outside the privacy guard while it is on', () => {
        const store = createStore()
        store.add('hidden chat quote')
        store.add('guarded copy', { guarded: true })
        expect(texts(store, { guarded: true })).toEqual(['guarded copy'])

        const hidden = store.list().entries.find((entry: { text: string }) => entry.text === 'hidden chat quote')
        expect(store.remove(hidden.id, { guarded: true })).toBe(false)
        store.clearUnpinned({ guarded: true })
        expect(texts(store)).toEqual(['hidden chat quote'])
    })
})

import { describe, expect, it, vi } from 'vitest'

// getPersonaPrompt() reads getDatabase() (-> DBState.db) and get(selectedCharID).
// Mock both sources so we can drive the chat's bindedPersona and the global
// personaPrompt independently. selectedCharID must be a real store so the
// module-under-test's `get(selectedCharID)` resolves.
// vi.mock factories are hoisted above imports, so the shared state they close
// over must be created with vi.hoisted().
const mocks = vi.hoisted(() => {
    const { writable } = require('svelte/store')
    return {
        selectedCharID: writable(0),
        dbRef: { db: {} as any },
        selIdState: { selId: -1 },
    }
})

vi.mock(import('./stores.svelte'), () => ({
    selectedCharID: mocks.selectedCharID,
    DBState: mocks.dbRef,
    selIdState: mocks.selIdState,
} as any))
vi.mock(import('./storage/database.svelte'), () => ({
    getDatabase: () => mocks.dbRef.db,
} as any))

import { getPersonaPrompt, getUserName, getUserIcon, getUserIconProtrait } from './util'

// Regression guard for the persona-prompt bind bug:
// when a chat has a bindedPersona, getPersonaPrompt() must return that
// persona's prompt — independently of the global DBState.db.personaPrompt.
// The prompt builder gates the personaPrompt block on this function's result,
// so if it fell back to the (empty) global value the block would be dropped.

function setup(opts: {
    globalPersonaPrompt: string
    bindedPersona?: string
    personas?: Array<{ id: string, personaPrompt: string }>
}) {
    mocks.selectedCharID.set(0)
    mocks.dbRef.db = {
        personaPrompt: opts.globalPersonaPrompt,
        personas: opts.personas ?? [],
        characters: [
            {
                chatPage: 0,
                chats: [
                    { bindedPersona: opts.bindedPersona ?? '' },
                ],
            },
        ],
    }
}

describe('getPersonaPrompt', () => {
    it('resolves name, icon, portrait, and prompt through the same binding state', () => {
        setup({ globalPersonaPrompt: 'global prompt', bindedPersona: 'p1' })
        Object.assign(mocks.dbRef.db, {
            username: 'Global', userIcon: 'global.png', selectedPersona: 0,
            personas: [
                { id: 'p0', name: 'Global', icon: 'global.png', largePortrait: false },
                { id: 'p1', name: 'Bound', icon: 'bound.png', largePortrait: true, personaPrompt: 'bound prompt' },
            ],
        })
        const values = () => [getUserName(), getUserIcon(), getUserIconProtrait(), getPersonaPrompt()]
        expect(values()).toEqual(['Bound', 'bound.png', true, 'bound prompt'])
        mocks.dbRef.db.showPersonaInSidebar = false
        expect(values()).toEqual(['Global', 'global.png', false, 'global prompt'])
        expect(mocks.dbRef.db.characters[0].chats[0].bindedPersona).toBe('p1')
        mocks.dbRef.db.showPersonaInSidebar = true
        expect(values()).toEqual(['Bound', 'bound.png', true, 'bound prompt'])
    })

    it('returns the global personaPrompt when no persona is bound', () => {
        setup({ globalPersonaPrompt: 'global prompt' })
        expect(getPersonaPrompt()).toBe('global prompt')
    })

    it('returns the bound persona prompt even when the global personaPrompt is empty', () => {
        // This is the regressing case: global empty, bound persona non-empty.
        setup({
            globalPersonaPrompt: '',
            bindedPersona: 'p1',
            personas: [{ id: 'p1', personaPrompt: 'bound prompt' }],
        })
        expect(getPersonaPrompt()).toBe('bound prompt')
    })

    it('prefers the bound persona prompt over the global one', () => {
        setup({
            globalPersonaPrompt: 'global prompt',
            bindedPersona: 'p1',
            personas: [{ id: 'p1', personaPrompt: 'bound prompt' }],
        })
        expect(getPersonaPrompt()).toBe('bound prompt')
    })

    it('falls back to the global prompt when bindedPersona id is not found', () => {
        setup({
            globalPersonaPrompt: 'global prompt',
            bindedPersona: 'missing',
            personas: [{ id: 'p1', personaPrompt: 'bound prompt' }],
        })
        expect(getPersonaPrompt()).toBe('global prompt')
    })
})

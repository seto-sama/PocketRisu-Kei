import { describe, expect, it, vi } from 'vitest'

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

import { getPersonaPrompt, getUserName, getUserIcon } from './util'

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
                chats: [
                    { bindedPersona: opts.bindedPersona ?? '' },
                ],
            },
        ],
    }
}

describe('getPersonaPrompt', () => {
    it('resolves name, icon, and prompt through the same binding state', () => {
        setup({ globalPersonaPrompt: 'global prompt', bindedPersona: 'p1' })
        Object.assign(mocks.dbRef.db, {
            username: 'Global', userIcon: 'global.png',
            personas: [
                { id: 'p1', name: 'Bound', icon: 'bound.png', personaPrompt: 'bound prompt' },
            ],
        })
        const values = () => [getUserName(), getUserIcon(), getPersonaPrompt()]
        expect(values()).toEqual(['Bound', 'bound.png', 'bound prompt'])
        mocks.dbRef.db.showPersonaInSidebar = false
        expect(values()).toEqual(['Global', 'global.png', 'global prompt'])
        expect(mocks.dbRef.db.characters[0].chats[0].bindedPersona).toBe('p1')
        mocks.dbRef.db.showPersonaInSidebar = true
        expect(values()).toEqual(['Bound', 'bound.png', 'bound prompt'])
    })

    it('returns the global personaPrompt when no persona is bound', () => {
        setup({ globalPersonaPrompt: 'global prompt' })
        expect(getPersonaPrompt()).toBe('global prompt')
    })

    it('returns the bound persona prompt even when the global personaPrompt is empty', () => {
        setup({
            globalPersonaPrompt: '',
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

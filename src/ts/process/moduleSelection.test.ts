import { describe, expect, it } from 'vitest'
import type { Chat, Database, character } from '../storage/database.svelte'
import type { RisuModule } from './modules'
import { getEnabledModules, setGlobalModuleEnabled } from './moduleSelection'

describe('global module activation', () => {
    it('clears the module from every character and chat without restoring those links when disabled', () => {
        const db = {
            enabledModules: ['other-global'],
            characters: [
                { modules: ['target', 'other'], chats: [{ modules: ['target', 'chat-only'] }, {}] },
                { modules: ['target'], chats: [{ modules: ['target'] }] },
                { chats: [] },
            ],
        } as unknown as Database

        setGlobalModuleEnabled(db, 'target', true)
        setGlobalModuleEnabled(db, 'target', true)
        expect(db.enabledModules).toEqual(['other-global', 'target'])
        expect(db.characters).toEqual([
            { modules: ['other'], chats: [{ modules: ['chat-only'] }, {}] },
            { modules: [], chats: [{ modules: [] }] },
            { chats: [] },
        ])

        setGlobalModuleEnabled(db, 'target', false)
        expect(db.enabledModules).toEqual(['other-global'])
        expect(db.characters[0].modules).toEqual(['other'])
        expect(db.characters[1].chats[0].modules).toEqual([])
    })
})

describe('enabled modules', () => {
    it('combines all enabled sources and resolves namespaces without duplicate modules', () => {
        const db = {
            enabledModules: ['global', 'shared'],
            selectedPersona: 0,
            personas: [{ id: 'persona' }],
            personaEnabledModules: { persona: ['persona-module'] },
            moduleIntergration: ' integrated, missing, ',
            modules: [
                { id: 'global' },
                { id: 'persona-module' },
                { id: 'character-module' },
                { id: 'chat-module' },
                { id: 'namespaced', namespace: 'shared' },
                { id: 'integrated' },
                { id: 'global' },
                { id: 'disabled' },
            ],
        } as unknown as Database
        const char = { modules: ['character-module', 'global'] } as character
        const chat = { modules: ['chat-module', 'namespaced'] } as Chat

        expect(getEnabledModules(db, char, chat).map(module => module.id)).toEqual([
            'global', 'persona-module', 'character-module', 'chat-module', 'namespaced', 'integrated',
        ])
    })

    it('retains the bound persona module selection when resolving a registered embedded module', () => {
        const embedded = { id: '$embedded' } as RisuModule
        const db = {
            selectedPersona: 0,
            personas: [{ id: 'global' }, { id: 'bound', embeddedModule: embedded }],
            modules: [embedded],
        } as unknown as Database
        const chat = { bindedPersona: 'bound' } as Chat

        expect(getEnabledModules(db, undefined, chat)).toEqual([embedded])
        db.showPersonaInSidebar = false
        expect(getEnabledModules(db, undefined, chat)).toEqual([])
    })
})

import type { Chat, Database, character } from './database.svelte'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../stores.svelte', () => ({
    DBState: { db: {} as any },
    selectedCharID: { subscribe: (run: (value: number) => void) => { run(0); return () => {} } },
    selIdState: { selId: -1 },
}))
vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: () => {},
    saveAsset: async () => '',
}))
vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: null } }))
vi.mock('../alert', () => ({ notifySuccess: () => {}, alertError: () => {} }))
vi.mock('../../lang', () => ({ language: {}, changeLanguage: () => {} }))

const {
    normalizePersonaSelection,
    normalizeSystemRoleReplacement,
    setDatabaseLite,
    loadTogglesFromChat,
    saveTogglesToChat,
    getToggleKeys,
} = await import('./database.svelte')
const { isChatStub } = await import('./chatStub')
const { DBState } = await import('../stores.svelte')

describe('persona module toggles', () => {
    it('uses the selected persona modules while chat binding is hidden', () => {
        const database = {
            showPersonaInSidebar: false,
            selectedPersona: 0,
            personas: [{ id: 'global' }, { id: 'bound' }],
            personaEnabledModules: { global: ['global-module'], bound: ['bound-module'] },
            modules: [
                { id: 'global-module', customModuleToggle: 'global=Global' },
                { id: 'bound-module', customModuleToggle: 'bound=Bound' },
            ],
        } as unknown as Database
        const chat = { bindedPersona: 'bound' } as Chat
        const character = {} as character

        expect(getToggleKeys(database, character, chat)).toEqual(['toggle_global'])
        database.showPersonaInSidebar = true
        expect(getToggleKeys(database, character, chat)).toEqual(['toggle_bound'])
        expect(chat.bindedPersona).toBe('bound')
    })
})

describe('hidden chat toggle binding', () => {
    it('ignores saved bindings on chat switch and does not save changes', () => {
        const previous = DBState.db
        const savedToggleValues = { toggle_test: 'saved' }
        const chat: Chat = { savedToggleValues, message: [], note: '', name: '', localLore: [] }
        try {
            DBState.db = {
                disableToggleBinding: true,
                globalChatVariables: { toggle_test: 'current' },
                characters: [{ chatPage: 0, chats: [chat] }],
            } as unknown as Database

            loadTogglesFromChat(chat)
            saveTogglesToChat()

            expect(DBState.db.globalChatVariables.toggle_test).toBe('current')
            expect(chat.savedToggleValues).toEqual({ toggle_test: 'saved' })

            DBState.db.disableToggleBinding = false
            loadTogglesFromChat(chat)
            expect(DBState.db.globalChatVariables.toggle_test).toBe('saved')
        } finally {
            DBState.db = previous
        }
    })
})

describe('database chat normalization', () => {
    it('preserves server stubs while assigning ids to hydrated messages', () => {
        const stub = { id: 'stub-chat', name: 'Stub', _stub: true }
        const full: {
            id: string
            name: string
            message: Array<{ role: string, data: string, chatId?: string }>
        } = {
            id: 'full-chat',
            name: 'Full',
            message: [{ role: 'user', data: 'Hello' }],
        }
        const database = {
            characters: [{ chats: [stub, full] }],
        } as any

        setDatabaseLite(database)

        expect(isChatStub(stub)).toBe(true)
        expect(stub).not.toHaveProperty('message')
        expect(full.message[0].chatId).toEqual(expect.any(String))
    })
})

describe('database settings normalization', () => {
    it('rebuilds an empty persona list and resets its selection', () => {
        const database = {
            username: 'User',
            userIcon: 'icon.png',
            userNote: 'note',
            personas: [],
            selectedPersona: 4,
        } as any

        normalizePersonaSelection(database)

        expect(database.personas).toEqual([{
            id: expect.any(String),
            name: 'User',
            personaPrompt: '',
            icon: 'icon.png',
            note: 'note',
            largePortrait: false,
        }])
        expect(database.selectedPersona).toBe(0)
    })

    it('clamps a stale persona index without replacing valid personas', () => {
        const personas = [{ name: 'A' }, { name: 'B' }]
        const database = { personas, selectedPersona: 2 } as any

        normalizePersonaSelection(database)

        expect(database.personas).toBe(personas)
        expect(database.personas.every((persona: { id?: string }) => !!persona.id)).toBe(true)
        expect(database.selectedPersona).toBe(0)
    })

    it('normalizes an empty system role replacement to user', () => {
        expect(normalizeSystemRoleReplacement('')).toBe('user')
        expect(normalizeSystemRoleReplacement('assistant')).toBe('assistant')
    })
})

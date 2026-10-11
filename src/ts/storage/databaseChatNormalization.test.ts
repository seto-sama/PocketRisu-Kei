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
    initializeToggleValues,
    applyToggleValues,
} = await import('./database.svelte')
const { isChatStub } = await import('./chatStub')
const { DBState } = await import('../stores.svelte')

describe('persona module toggles', () => {
    it('uses the selected persona modules while chat binding is hidden', () => {
        const database = {
            globalChatVariables: {},
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

        initializeToggleValues(database, character, chat)
        expect(database.globalChatVariables).toEqual({ toggle_global: '0' })
        database.showPersonaInSidebar = true
        database.globalChatVariables = {}
        initializeToggleValues(database, character, chat)
        expect(database.globalChatVariables).toEqual({ toggle_bound: '0' })
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

describe('chat toggle pins', () => {
    it('pins defaults for existing toggles and restores them while preserving later toggles', () => {
        const previous = DBState.db
        const chat: Chat = { message: [], note: '', name: '', localLore: [] }
        try {
            DBState.db = {
                customPromptTemplateToggle: 'value=Value=text\nflag=Flag\nchoice=Choice=select=First,Second\ntext=Text=text\nheading=Heading=caption',
                globalChatVariables: { toggle_value: 'pinned', toggle_orphan: 'orphan', other: 'untouched' },
                characters: [{ customModuleToggle: 'character=Character', chatPage: 0, chats: [chat] }],
            } as unknown as Database

            saveTogglesToChat()
            expect(chat.savedToggleValues).toEqual({
                toggle_value: 'pinned', toggle_flag: '0', toggle_choice: '0', toggle_text: '', toggle_character: '0', toggle_orphan: 'orphan',
            })
            expect(DBState.db.globalChatVariables).toEqual({ ...chat.savedToggleValues, other: 'untouched' })

            DBState.db.modules = [{ id: 'new-module', customModuleToggle: 'later=Later=text' }] as any
            DBState.db.enabledModules = ['new-module']
            Object.assign(DBState.db.globalChatVariables, {
                toggle_value: 'changed', toggle_flag: '1', toggle_choice: '1', toggle_text: 'changed', toggle_character: '1', toggle_later: 'keep', toggle_orphan: 'changed',
            })
            loadTogglesFromChat(chat)

            expect(DBState.db.globalChatVariables).toEqual({
                ...chat.savedToggleValues, toggle_later: 'keep', other: 'untouched',
            })
        } finally {
            DBState.db = previous
        }
    })

    it('resets missing preset values to control defaults and preserves explicit values', () => {
        const previous = DBState.db
        try {
            DBState.db = {
                customPromptTemplateToggle: 'value=Value=text\nflag=Flag\nchoice=Choice=select=First,Second\narea=Area=textarea',
                globalChatVariables: { toggle_value: 'old', toggle_flag: '1', toggle_choice: '1', toggle_area: 'old', other: 'keep' },
                characters: [],
            } as unknown as Database
            applyToggleValues({ toggle_value: '', toggle_orphan: 'null' })
            expect(DBState.db.globalChatVariables).toEqual({
                toggle_value: '', toggle_flag: '0', toggle_choice: '0', toggle_area: '', toggle_orphan: 'null', other: 'keep',
            })
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
        const personas = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
        const database = { personas, selectedPersona: 2 } as any

        normalizePersonaSelection(database)

        expect(database.personas).toBe(personas)
        expect(database.selectedPersona).toBe(0)
    })

    it('normalizes an empty system role replacement to user', () => {
        expect(normalizeSystemRoleReplacement('')).toBe('user')
        expect(normalizeSystemRoleReplacement('assistant')).toBe('assistant')
    })
})

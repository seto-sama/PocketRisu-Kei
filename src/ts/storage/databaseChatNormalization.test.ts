import { describe, expect, it, vi } from 'vitest'

vi.mock('../stores.svelte', () => ({
    DBState: { db: {} as any },
    selectedCharID: { subscribe: () => () => {} },
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
} = await import('./database.svelte')
const { isChatStub } = await import('./chatStub')

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
        expect(database.selectedPersona).toBe(0)
    })

    it('normalizes an empty system role replacement to user', () => {
        expect(normalizeSystemRoleReplacement('')).toBe('user')
        expect(normalizeSystemRoleReplacement('assistant')).toBe('assistant')
    })
})

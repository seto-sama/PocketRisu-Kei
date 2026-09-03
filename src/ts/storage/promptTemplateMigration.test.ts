import { beforeEach, describe, expect, test, vi } from 'vitest'

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

const { importPreset, setDatabase } = await import('./database.svelte')
const { DBState } = await import('../stores.svelte') as any

function makeLegacyDatabase(promptTemplate: null | undefined) {
    return {
        mainPrompt: 'Legacy main',
        jailbreak: 'Legacy jailbreak',
        globalNote: 'Legacy global note',
        formatingOrder: ['main', 'jailbreak', 'globalNote'],
        promptTemplate,
        botPresets: [],
    } as any
}

const migratedLegacyTextItems = [
    { type: 'plain', type2: 'main', text: 'Legacy main', role: 'system' },
    { type: 'jailbreak', type2: 'normal', text: 'Legacy jailbreak', role: 'system' },
    { type: 'plain', type2: 'globalNote', text: 'Legacy global note', role: 'system' },
]

beforeEach(() => {
    DBState.db = { botPresets: [] }
})

describe('legacy prompt template migration', () => {
    test.each([
        ['undefined', undefined],
        ['null', null],
    ])('materializes %s promptTemplate from legacy prompt fields', (_, promptTemplate) => {
        const database = makeLegacyDatabase(promptTemplate)

        setDatabase(database)

        expect(database.promptTemplate).toEqual(migratedLegacyTextItems)
    })

    test('preserves an explicitly empty prompt template', () => {
        const database = {
            ...makeLegacyDatabase(undefined),
            promptTemplate: [],
            botPresets: [{
                id: 'explicit-empty',
                mainPrompt: 'Preset legacy main',
                jailbreak: 'Preset legacy jailbreak',
                globalNote: 'Preset legacy global note',
                formatingOrder: ['main', 'jailbreak', 'globalNote'],
                promptTemplate: [],
            }],
        } as any

        setDatabase(database)

        expect(database.promptTemplate).toEqual([])
        expect(database.botPresets[0].promptTemplate).toEqual([])
    })

    test('preserves legacy format order and maps legacy roles', () => {
        const database = {
            mainPrompt: '@@user\nUser main\n@@assistant\nAssistant main',
            jailbreak: '@@system\nSystem jailbreak',
            globalNote: '@@assistant\nAssistant note',
            formatingOrder: [
                'globalNote',
                'description',
                'main',
                'chats',
                'lastChat',
                'jailbreak',
                'postEverything',
            ],
            promptTemplate: null,
            botPresets: [],
        } as any

        setDatabase(database)

        expect(database.promptTemplate).toEqual([
            { type: 'plain', type2: 'globalNote', text: 'Assistant note', role: 'bot' },
            { type: 'description' },
            { type: 'plain', type2: 'main', text: 'User main', role: 'user' },
            { type: 'plain', type2: 'main', text: 'Assistant main', role: 'bot' },
            { type: 'chat', rangeStart: 0, rangeEnd: -1 },
            { type: 'chat', rangeStart: -1, rangeEnd: 'end' },
            { type: 'jailbreak', type2: 'normal', text: 'System jailbreak', role: 'system' },
            { type: 'postEverything' },
        ])
    })

    test('migrates an imported legacy JSON preset that omitted promptTemplate', async () => {
        const importedPreset = {
            name: 'Imported legacy preset',
            mainPrompt: '@@user\nImported main',
            jailbreak: 'Imported jailbreak',
            globalNote: '@@assistant\nImported note',
            formatingOrder: ['jailbreak', 'main', 'globalNote'],
        }

        await importPreset({
            name: 'legacy.json',
            data: new TextEncoder().encode(JSON.stringify(importedPreset)),
        })

        expect(DBState.db.botPresets).toHaveLength(1)
        expect(DBState.db.botPresets[0].promptTemplate).toEqual([
            { type: 'jailbreak', type2: 'normal', text: 'Imported jailbreak', role: 'system' },
            { type: 'plain', type2: 'main', text: 'Imported main', role: 'user' },
            { type: 'plain', type2: 'globalNote', text: 'Imported note', role: 'bot' },
        ])
    })
})

describe('external prompt preset import', () => {
    test('converts a SillyTavern chat completion preset', async () => {
        const importedPreset = {
            name: 'ST preset',
            chat_completion_source: 'openai',
            temperature: 0.55,
            prompts: [{
                identifier: 'main',
                content: 'Imported system prompt',
                role: 'assistant',
            }],
            prompt_order: [{
                order: [{ identifier: 'main', enabled: true }],
            }],
        }

        await importPreset({
            name: 'st-chat.json',
            data: new TextEncoder().encode(JSON.stringify(importedPreset)),
        })

        expect(DBState.db.botPresets).toHaveLength(1)
        expect(DBState.db.botPresets[0]).toMatchObject({
            name: 'ST preset',
            promptTemplate: [{
                type: 'plain',
                type2: 'main',
                text: 'Imported system prompt',
                role: 'bot',
            }],
        })
        expect(DBState.db.botPresets[0].temperature).toBeCloseTo(55)
    })

})

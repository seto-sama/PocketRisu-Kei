import { describe, test, expect, beforeEach, vi } from 'vitest'

// Isolate preset state transitions from storage and plugin startup.

vi.mock('../stores.svelte', () => {
    const state: { db: any } = { db: {} }
    const noopStore = { subscribe: () => () => {}, set: () => {}, update: () => {} }
    return {
        DBState: state,
        selectedCharID: noopStore,
        selIdState: { selId: -1 },
    }
})

vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: () => {},
    saveAsset: () => Promise.resolve(''),
}))

vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: null } }))

vi.mock('../alert', () => ({
    notifySuccess: () => {},
    alertError: () => {},
}))

vi.mock('../../lang', () => ({
    language: {},
    changeLanguage: () => {},
}))

const databaseModule = await import('./database.svelte')
const storesModule = await import('../stores.svelte')
const {
    applyHypaPresetIntegration,
    createBotPresetTemplate,
    changeToPreset,
    copyPreset,
    getActiveBotPreset,
    saveCurrentPreset,
    setDatabase,
    setDatabaseLite,
    setPreset,
} = databaseModule
const { DBState } = storesModule as any

function makePreset(id: string, name: string) {
    return { ...createBotPresetTemplate(), id, name }
}

beforeEach(() => {
    const db: any = {
        botPresets: [
            makePreset('id-a', 'A'),
            makePreset('id-b', 'B'),
            makePreset('id-c', 'C'),
        ],
        activePromptPresetId: 'id-b',
    }
    setDatabase(db)
})

describe('empty database initialization', () => {
    test('creates the root structures required by patch sync', () => {
        const db: any = {}

        setDatabase(db)

        expect(db.characters).toEqual([])
        expect(db.botPresets).toHaveLength(1)
        expect(db.botPresets[0].id).toEqual(expect.any(String))
        expect(db.modules).toEqual([])
        expect(db.personas).toHaveLength(1)
        expect(db.pluginCustomStorage).toEqual({})
    })

    test('preserves legacy fields except the retired model-registry notice snapshot', () => {
        const db: any = {
            additionalPrompt: { role: 'system', content: 'legacy prompt' },
            descriptionPrefix: 'legacy prefix',
            presetChain: ['legacy-preset'],
            promptPreprocess: { mode: 'legacy' },
            customModels: [{ id: 'xcustom:::legacy', opaque: true }],
            modelPresetLocalRegistryOnly: true,
            modelRegistrySeen: { legacy: 1 },
            useCustomModelRegistry: true,
            modelProfileRegistryBaseUrl: 'https://legacy.example',
            aiModel: 'legacy-main',
            subModel: 'legacy-sub',
            botPresets: [{
                ...makePreset('legacy-preset', 'Legacy'),
                promptPreprocess: { nested: true },
            }],
        }

        setDatabase(db)

        expect(db.additionalPrompt).toEqual({ role: 'system', content: 'legacy prompt' })
        expect(db.descriptionPrefix).toBe('legacy prefix')
        expect(db.presetChain).toEqual(['legacy-preset'])
        expect(db.promptPreprocess).toEqual({ mode: 'legacy' })
        expect(db.customModels).toEqual([{ id: 'xcustom:::legacy', opaque: true }])
        expect(db.modelPresetLocalRegistryOnly).toBe(true)
        expect(db.modelRegistrySeen).toBeUndefined()
        expect(db.useCustomModelRegistry).toBe(true)
        expect(db.modelProfileRegistryBaseUrl).toBe('https://legacy.example')
        expect(db.aiModel).toBe('legacy-main')
        expect(db.subModel).toBe('legacy-sub')
        expect(db.botPresets[0].promptPreprocess).toEqual({ nested: true })
    })
})

describe('createBotPresetTemplate', () => {
    test('assigns a unique UUID on each call', () => {
        const a = createBotPresetTemplate()
        const b = createBotPresetTemplate()
        expect(a.id).toBeTruthy()
        expect(b.id).toBeTruthy()
        expect(a.id).not.toBe(b.id)
    })

    test('returns a deep-cloned template (mutating one does not affect another)', () => {
        const a = createBotPresetTemplate()
        const b = createBotPresetTemplate()
        a.name = 'Mutated'
        expect(b.name).not.toBe('Mutated')
    })

    test('does not add legacy main or sub model fields to new prompt presets', () => {
        const preset = createBotPresetTemplate() as any
        expect(preset).not.toHaveProperty('aiModel')
        expect(preset).not.toHaveProperty('subModel')
    })
})

describe('legacy prompt-preset model fields', () => {
    test('does not apply main or sub model selection from a prompt preset', () => {
        const db: any = {}
        setDatabase(db)
        db.aiModel = 'current-main'
        db.subModel = 'current-sub'

        setPreset(db, {
            ...makePreset('legacy', 'Legacy'),
            aiModel: 'legacy-main',
            subModel: 'legacy-sub',
        } as any)

        expect(db.aiModel).toBe('current-main')
        expect(db.subModel).toBe('current-sub')
    })

    test('preserves unknown serialized fields without replacing their values', () => {
        const db: any = {
            botPresets: [{
                ...makePreset('legacy', 'Legacy'),
                aiModel: 'legacy-main',
                subModel: 'legacy-sub',
                futureField: { enabled: true },
            }],
            activePromptPresetId: 'legacy',
        }
        setDatabase(db)
        db.aiModel = 'current-main'
        db.subModel = 'current-sub'
        saveCurrentPreset()

        expect(db.botPresets[0].aiModel).toBe('legacy-main')
        expect(db.botPresets[0].subModel).toBe('legacy-sub')
        expect(db.botPresets[0].futureField).toEqual({ enabled: true })
    })
})

describe('active prompt preset IDs', () => {
    test('keeps the selected preset through reorder, edits, and duplication', () => {
        DBState.db.botPresets = [
            DBState.db.botPresets[2],
            DBState.db.botPresets[0],
            DBState.db.botPresets[1],
        ]
        DBState.db.mainPrompt = 'edited prompt for B'

        saveCurrentPreset()

        expect(DBState.db.activePromptPresetId).toBe('id-b')
        expect(getActiveBotPreset()?.id).toBe('id-b')
        expect(DBState.db.botPresets.find((preset: any) => preset.id === 'id-b').mainPrompt).toBe('edited prompt for B')
        expect(DBState.db.botPresets.find((preset: any) => preset.id === 'id-a').mainPrompt).not.toBe('edited prompt for B')

        const copyId = copyPreset(2)
        expect(copyId).toBeTruthy()
        expect(copyId).not.toBe('id-b')
        changeToPreset(copyId!)
        expect(DBState.db.activePromptPresetId).toBe(copyId)
        expect(DBState.db.mainPrompt).toBe('edited prompt for B')
    })

    test('skips saving when the selected preset was deleted', () => {
        const otherPresetsBefore = DBState.db.botPresets
            .filter((preset: any) => preset.id !== 'id-b')
            .map((preset: any) => ({ id: preset.id, mainPrompt: preset.mainPrompt }))
        DBState.db.botPresets = DBState.db.botPresets.filter((preset: any) => preset.id !== 'id-b')
        DBState.db.mainPrompt = 'orphaned root edit'

        saveCurrentPreset()

        expect(getActiveBotPreset()).toBeNull()
        expect(DBState.db.botPresets.map((preset: any) => ({ id: preset.id, mainPrompt: preset.mainPrompt })))
            .toEqual(otherPresetsBefore)
    })

    test('validates a target before saving and preserves edits when switching or reselecting', () => {
        const presetB = DBState.db.botPresets.find((preset: any) => preset.id === 'id-b')
        DBState.db.mainPrompt = 'edited prompt for B'

        changeToPreset('missing')
        expect(DBState.db.activePromptPresetId).toBe('id-b')
        expect(presetB.mainPrompt).not.toBe('edited prompt for B')

        changeToPreset('id-c')
        expect(DBState.db.activePromptPresetId).toBe('id-c')
        expect(DBState.db.botPresets.find((preset: any) => preset.id === 'id-b').mainPrompt).toBe('edited prompt for B')

        DBState.db.mainPrompt = 'edited prompt for C'
        changeToPreset('id-c')
        expect(DBState.db.activePromptPresetId).toBe('id-c')
        expect(DBState.db.mainPrompt).toBe('edited prompt for C')
        expect(DBState.db.botPresets.find((preset: any) => preset.id === 'id-c').mainPrompt).toBe('edited prompt for C')
    })
})

describe('prompt preset Hypa integration', () => {
    function setup() {
        const db: any = {}
        setDatabase(db)
        db.hypaV3Presets = [
            { name: 'Default' }, { name: 'Story memory' }, { name: 'Story memory' },
        ]
        db.hypaV3PresetId = 0
        return db
    }

    test('persists the link and selects the first matching memory preset when switching back', () => {
        const db = setup()
        db.hypaPresetIntegration = 'Story memory'
        saveCurrentPreset()
        const saved = structuredClone(db.botPresets.find((preset: any) => preset.id === db.activePromptPresetId))
        expect(saved.hypaPresetIntegration).toBe('Story memory')

        setPreset(db, { ...makePreset('other', 'Other'), hypaPresetIntegration: 'Default' })
        expect(db.hypaV3PresetId).toBe(0)
        setPreset(db, saved)
        expect(db.hypaV3PresetId).toBe(1)
    })

    test.each(['', 'Missing', 'story memory', ' Story memory', 'Story memory ', 'Story  memory', undefined])(
        'keeps the selected memory preset for an empty or unmatched link (%s)', (name) => {
            const db = setup()
            db.hypaV3PresetId = 1
            db.hypaPresetIntegration = 'Default'
            setPreset(db, { ...makePreset('other', 'Other'), hypaPresetIntegration: name })
            expect(db.hypaV3PresetId).toBe(1)
            expect(db.hypaPresetIntegration).toBe(name ?? '')
        },
    )

    test('applies an edited name without enabling memory', () => {
        const db = setup()
        db.hypaV3 = false
        db.hypaPresetIntegration = 'Story memory'
        applyHypaPresetIntegration(db)
        expect(db.hypaV3PresetId).toBe(1)
        expect(db.hypaV3).toBe(false)
    })
})

describe('prompt preset selection normalization', () => {
    test.each([
        { kind: 'full', install: setDatabase },
        { kind: 'lite', install: setDatabaseLite },
    ])('$kind install normalizes absent, empty, and dangling selection IDs', ({ install }) => {
        const makeDatabase = (selection?: string) => ({
            botPresets: [makePreset('id-a', 'A'), makePreset('id-b', 'B')],
            ...(selection === undefined ? {} : { activePromptPresetId: selection }),
        }) as any

        const missingSelection = makeDatabase()
        missingSelection.botPresetsId = 1
        install(missingSelection)
        expect(missingSelection.activePromptPresetId).toBe('id-a')
        expect(missingSelection).not.toHaveProperty('botPresetsId')

        const noSelection = makeDatabase('')
        install(noSelection)
        expect(noSelection.activePromptPresetId).toBe('')

        const danglingSelection = makeDatabase('deleted-id')
        install(danglingSelection)
        expect(danglingSelection.activePromptPresetId).toBe('')
        expect(danglingSelection.botPresets.map((preset: any) => preset.id)).toEqual(['id-a', 'id-b'])
    })
})

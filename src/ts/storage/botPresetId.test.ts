import { describe, test, expect, beforeEach, vi } from 'vitest'

// Mock heavy dependencies so importing database.svelte doesn't drag in the
// full Svelte/forage/globalApi stack. We do NOT mock database.svelte itself —
// these tests exercise the real botPreset id helpers and the active-preset
// stability invariant that PR S3 establishes.

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
    createBotPresetTemplate,
    getActiveBotPreset,
    getActiveBotPresetId,
    getBotPresetById,
    getBotPresetIndexById,
    saveCurrentPreset,
    setDatabase,
    setPreset,
    setActiveBotPresetById,
    withStableActivePreset,
} = databaseModule
const { DBState } = storesModule as any

function makePreset(id: string, name: string) {
    return { id, name, mainPrompt: '', jailbreak: '', globalNote: '', temperature: 0, maxContext: 0, maxResponse: 0, frequencyPenalty: 0, PresensePenalty: 0, formatingOrder: [], bias: [] }
}

beforeEach(() => {
    DBState.db = {
        botPresets: [
            makePreset('id-a', 'A'),
            makePreset('id-b', 'B'),
            makePreset('id-c', 'C'),
        ],
        botPresetsId: 1,
    }
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

    test('preserves retired fields that are no longer part of the typed database', () => {
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
        expect(db.modelRegistrySeen).toEqual({ legacy: 1 })
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
            botPresetsId: 0,
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

describe('id lookup helpers', () => {
    test('getActiveBotPreset returns the entry at botPresetsId', () => {
        expect(getActiveBotPreset()?.id).toBe('id-b')
    })

    test('getActiveBotPresetId returns the active id', () => {
        expect(getActiveBotPresetId()).toBe('id-b')
    })

    test('getBotPresetById finds by id', () => {
        expect(getBotPresetById('id-c')?.name).toBe('C')
    })

    test('getBotPresetIndexById returns -1 when not found', () => {
        expect(getBotPresetIndexById('id-missing')).toBe(-1)
    })

    test('setActiveBotPresetById updates botPresetsId via findIndex', () => {
        setActiveBotPresetById('id-c')
        expect(DBState.db.botPresetsId).toBe(2)
    })

    test('setActiveBotPresetById(undefined) sets the no-active sentinel', () => {
        setActiveBotPresetById(undefined)
        expect(DBState.db.botPresetsId).toBe(-1)
    })
})

describe('withStableActivePreset', () => {
    test('preserves active id when array is reordered', () => {
        // botPresetsId=1 (id-b) is active. Move 'B' from index 1 to index 0.
        withStableActivePreset(() => {
            const arr = DBState.db.botPresets
            const moved = arr.splice(1, 1)[0]
            arr.splice(0, 0, moved)
            DBState.db.botPresets = arr
        })
        // After reorder, B is at index 0. botPresetsId should follow.
        expect(DBState.db.botPresetsId).toBe(0)
        expect(getActiveBotPresetId()).toBe('id-b')
    })

    test('preserves active id when a non-active preset is removed', () => {
        // botPresetsId=1 (id-b). Remove id-a (index 0).
        withStableActivePreset(() => {
            DBState.db.botPresets.splice(0, 1)
        })
        // B should still be active (now at index 0).
        expect(getActiveBotPresetId()).toBe('id-b')
        expect(DBState.db.botPresetsId).toBe(0)
    })

    test('clamps to 0 when the active preset itself is removed', () => {
        // botPresetsId=1 (id-b). Remove id-b.
        withStableActivePreset(() => {
            DBState.db.botPresets.splice(1, 1)
        })
        // active id was id-b which no longer exists → fall back to 0.
        expect(DBState.db.botPresetsId).toBe(0)
        expect(getActiveBotPresetId()).toBe('id-a')
    })

    test('handles append (length grows) without losing active', () => {
        withStableActivePreset(() => {
            DBState.db.botPresets.push(makePreset('id-d', 'D'))
        })
        expect(getActiveBotPresetId()).toBe('id-b')
        expect(DBState.db.botPresetsId).toBe(1)
    })
})

describe('id migration safety', () => {
    test('helpers cope with presets missing an id (treat as not findable)', () => {
        DBState.db.botPresets = [
            { name: 'no-id-preset' },
            makePreset('id-x', 'X'),
        ]
        DBState.db.botPresetsId = 0
        // Active preset has no id → getActiveBotPresetId returns undefined,
        // setupping the migration path (setDatabase will fix it on next load).
        expect(getActiveBotPresetId()).toBeUndefined()
        // Lookup by id still works for the indexed entry.
        expect(getBotPresetIndexById('id-x')).toBe(1)
    })
})

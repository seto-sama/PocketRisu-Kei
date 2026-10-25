import { describe, expect, it } from 'vitest'
import { ensureDatabasePresetIds, ensureUniqueEntityIds } from './id'

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('entity ids', () => {
    it('assigns UUID v4 IDs to missing identities while preserving existing IDs', () => {
        const items: { id?: string }[] = [{ id: 'existing-id' }, {}, { id: '' }]

        ensureUniqueEntityIds(items)

        expect(items[0].id).toBe('existing-id')
        expect(new Set(items.map(item => item.id)).size).toBe(items.length)
        for (const item of items.slice(1)) {
            expect(item.id).toMatch(uuidV4)
        }
    })

    it('rejects duplicate IDs before assigning any missing IDs', () => {
        const items = [{}, { id: 'duplicate' }, { id: 'duplicate' }]
        const before = structuredClone(items)

        expect(() => ensureUniqueEntityIds(items)).toThrow('Duplicate entity ID: duplicate')
        expect(items).toEqual(before)
    })

    it('fills preset and persona IDs while leaving non-ID preset formats intact', () => {
        const database = {
            modelPresets: [{ name: 'Legacy model' }],
            personas: [{ id: 'existing-persona' }, { name: 'Legacy persona' }],
            togglePresets: [{ name: 'Toggle', values: {} }],
            imageStylePresets: [{ comment: 'Style', secondkey: 'lorebook-key' }],
        }
        const otherPresets = structuredClone([database.togglePresets, database.imageStylePresets])

        ensureDatabasePresetIds(database)

        expect((database.modelPresets[0] as { id?: string }).id).toMatch(uuidV4)
        expect(database.personas[0].id).toBe('existing-persona')
        expect(database.personas[1].id).toMatch(uuidV4)
        expect([database.togglePresets, database.imageStylePresets]).toEqual(otherPresets)
    })
})

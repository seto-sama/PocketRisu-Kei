import { describe, expect, it } from 'vitest'
import { normalizePresetTagState } from '../preset/tags'

describe('database preset tag normalization', () => {
    it('migrates legacy folder collections, memberships, and external bindings once', () => {
        const legacy = {
            promptPresetFolders: [{ id: 'tag-a', name: 'Legacy' }],
            botPresets: [{ name: 'Prompt', folderId: 'tag-a' }],
            personas: [{ name: 'Persona', folderId: ['tag-a', 'tag-b'] }],
            modules: [{ name: 'Module' }],
            imageStylePresetFolderBindings: {
                styleA: 'tag-a',
                styleB: ['tag-a', 'tag-b'],
            },
        }

        normalizePresetTagState(legacy)
        const normalized = legacy as unknown as Record<string, unknown>

        expect(normalized.promptPresetTags).toEqual([{ id: 'tag-a', name: 'Legacy' }])
        expect((legacy.botPresets[0] as { tagIds?: string[] }).tagIds).toEqual(['tag-a'])
        expect((legacy.personas[0] as { tagIds?: string[] }).tagIds).toEqual(['tag-a', 'tag-b'])
        expect(normalized.imageStylePresetTagBindings).toEqual({
            styleA: ['tag-a'],
            styleB: ['tag-a', 'tag-b'],
        })
        expect(normalized.promptPresetFolders).toBeUndefined()
        expect(normalized.imageStylePresetFolderBindings).toBeUndefined()

        const snapshot = structuredClone(normalized)
        normalizePresetTagState(legacy)
        expect(normalized).toEqual(snapshot)
    })
})

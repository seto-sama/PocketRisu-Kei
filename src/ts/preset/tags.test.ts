import { describe, expect, it } from 'vitest'
import {
    addPresetTag,
    normalizePresetTagBindings,
    normalizePresetTagFields,
    normalizeTagIds,
    removePresetTag,
    togglePresetTag,
} from './tags'

describe('preset tags', () => {
    it('normalizes legacy scalar folder membership into canonical tags', () => {
        const value = normalizePresetTagFields({ folderId: 'legacy' })
        expect(value).toEqual({ tagIds: ['legacy'] })
    })

    it('prefers canonical tags and removes invalid or duplicate ids', () => {
        const value = normalizePresetTagFields({
            folderId: 'legacy',
            tagIds: ['one', '', 'one', 3] as unknown as string[],
        })
        expect(value).toEqual({ tagIds: ['one'] })
    })

    it('adds, removes, and clears tags without duplicate membership', () => {
        expect(addPresetTag(['one'], 'two')).toEqual(['one', 'two'])
        expect(addPresetTag(['one'], 'one')).toEqual(['one'])
        expect(addPresetTag(['one'], undefined)).toBeUndefined()
        expect(removePresetTag(['one', 'two'], 'one')).toEqual(['two'])
        expect(removePresetTag(['one'], 'one')).toBeUndefined()
        expect(togglePresetTag(['one'], 'one')).toBeUndefined()
        expect(togglePresetTag(['one'], 'two')).toEqual(['one', 'two'])
    })

    it('normalizes external binding values', () => {
        expect(normalizePresetTagBindings({ one: 'tag', two: ['a', 'a'], empty: [] }))
            .toEqual({ one: ['tag'], two: ['a'] })
        expect(normalizeTagIds(null)).toBeUndefined()
    })
})

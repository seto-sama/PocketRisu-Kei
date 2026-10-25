import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
    applyGenerationInputMetadata,
    restoreGenerationOwnedMetadata,
} = require('./generationInputMetadata.cjs')

describe('generation input metadata', () => {
    it('updates durable activity metadata and drops runtime render state', () => {
        const database = {
            statics: { messages: 4, imports: 2 },
            characters: [{ chaId: 'character', reloadKeys: 99, lastInteraction: 1 }],
        }

        expect(applyGenerationInputMetadata(database, 'character', 1234)).toEqual({
            messages: 5,
            lastInteraction: 1234,
        })
        expect(database).toEqual({
            statics: { messages: 5, imports: 2 },
            characters: [{ chaId: 'character', lastInteraction: 1234 }],
        })
    })

    it('initializes missing statistics and leaves an unknown character untouched', () => {
        const database = { characters: [{ chaId: 'character' }] } as any
        expect(applyGenerationInputMetadata(database, 'missing', 1234)).toBeUndefined()
        expect(database.statics).toBeUndefined()

        applyGenerationInputMetadata(database, 'character', 1234)
        expect(database.statics).toEqual({ messages: 1, imports: 0 })
    })

    it('reattaches omitted generation metadata during a full browser write', () => {
        const current = {
            statics: { messages: 9, imports: 2 },
            characters: [
                { chaId: 'character', name: 'Old', lastInteraction: 1234 },
                { chaId: 'removed', lastInteraction: 4567 },
            ],
        }
        const incoming = {
            statics: { imports: 3 },
            characters: [
                { chaId: 'character', name: 'New' },
                { chaId: 'new-character', name: 'New character' },
            ],
        }

        expect(restoreGenerationOwnedMetadata(incoming, current)).toBe(incoming)
        expect(incoming).toEqual({
            statics: { messages: 9, imports: 3 },
            characters: [
                { chaId: 'character', name: 'New', lastInteraction: 1234 },
                { chaId: 'new-character', name: 'New character' },
            ],
        })
    })
})

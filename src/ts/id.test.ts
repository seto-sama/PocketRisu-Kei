import { describe, expect, it } from 'vitest'
import { createEntityId } from './id'

describe('entity ids', () => {
    it('creates non-empty unique identifiers', () => {
        const first = createEntityId()
        const second = createEntityId()

        expect(first).toEqual(expect.any(String))
        expect(first).not.toBe('')
        expect(second).not.toBe(first)
    })
})

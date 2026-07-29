import { describe, expect, test } from 'vitest'
import { isProfileVisible } from './visibility'

describe('isProfileVisible', () => {
    test("level 'all' (or undefined) shows every status", () => {
        for (const level of ['all', undefined] as const) {
            expect(isProfileVisible('current', level)).toBe(true)
            expect(isProfileVisible('outdated', level)).toBe(true)
            expect(isProfileVisible('deprecated', level)).toBe(true)
        }
    })

    test("level 'hideDeprecated' hides only deprecated", () => {
        expect(isProfileVisible('current', 'hideDeprecated')).toBe(true)
        expect(isProfileVisible('outdated', 'hideDeprecated')).toBe(true)
        expect(isProfileVisible('deprecated', 'hideDeprecated')).toBe(false)
    })

    test('missing status is treated as current (visible at every level)', () => {
        expect(isProfileVisible(undefined, 'all')).toBe(true)
        expect(isProfileVisible(undefined, 'hideDeprecated')).toBe(true)
    })
})

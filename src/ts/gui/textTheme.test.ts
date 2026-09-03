import { describe, expect, it } from 'vitest'
import { normalizeTextTheme } from './textTheme'

describe('normalizeTextTheme', () => {
    it.each(['highcontrast', 'custom'] as const)('preserves the non-default supported %s theme', (theme) => {
        expect(normalizeTextTheme(theme)).toBe(theme)
    })

    it('falls back to standard for an unsupported value', () => {
        expect(normalizeTextTheme(undefined)).toBe('standard')
    })
})

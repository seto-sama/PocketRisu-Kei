import { describe, expect, it } from 'vitest'
import { normalizeTextTheme, textThemeNames } from './textTheme'

describe('normalizeTextTheme', () => {
    it.each(textThemeNames)('preserves the supported %s theme', (theme) => {
        expect(normalizeTextTheme(theme)).toBe(theme)
    })

    it.each([undefined, null, '', 'vex', 'unknown'])(
        'falls back to standard for unsupported value %s',
        (theme) => {
            expect(normalizeTextTheme(theme)).toBe('standard')
        },
    )
})

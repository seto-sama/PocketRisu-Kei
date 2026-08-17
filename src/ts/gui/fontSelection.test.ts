import { describe, expect, it } from 'vitest'
import { resolveLocalFontSelection } from './fontSelection'

const families = [
    { family: 'SUIT Variable', variableWeight: true },
    { family: 'DIN 2014', variableWeight: false },
    { family: 'Example Thin', variableWeight: false },
]

describe('resolveLocalFontSelection', () => {
    it('resolves a local font with a numeric weight', () => {
        expect(resolveLocalFontSelection('SUIT Variable 700', families)).toEqual({
            family: '"SUIT Variable"',
            weight: 700,
        })
    })

    it('allows intermediate variable font weights and preserves fallbacks', () => {
        expect(resolveLocalFontSelection('SUIT Variable 475, sans-serif', families)).toEqual({
            family: '"SUIT Variable", sans-serif',
            weight: 475,
        })
    })

    it('uses the local family without forcing a weight', () => {
        expect(resolveLocalFontSelection('suit variable', families)).toEqual({
            family: '"SUIT Variable"',
            weight: null,
        })
    })

    it('preserves exact static family names', () => {
        expect(resolveLocalFontSelection('DIN 2014', families)).toEqual({
            family: '"DIN 2014"',
            weight: null,
        })
        expect(resolveLocalFontSelection('Example Thin', families)).toEqual({
            family: '"Example Thin"',
            weight: null,
        })
    })

    it('does not convert numeric suffixes for static families', () => {
        expect(resolveLocalFontSelection('DIN 2014 600', families)).toEqual({
            family: 'DIN 2014 600',
            weight: null,
        })
    })

    it('leaves unknown fonts and out-of-range weights unchanged', () => {
        expect(resolveLocalFontSelection('Unknown Font 700', families)).toEqual({
            family: 'Unknown Font 700',
            weight: null,
        })
        expect(resolveLocalFontSelection('SUIT Variable 950', families)).toEqual({
            family: 'SUIT Variable 950',
            weight: null,
        })
    })
})

import { describe, expect, it } from 'vitest'
import { getCBSHighlightRanges } from './highlight'

describe('getCBSHighlightRanges', () => {
    it('finds CBS tokens after long text offsets', () => {
        const prefix = 'x'.repeat(300)

        expect(getCBSHighlightRanges(`${prefix}{{char}}`)).toContainEqual([
            [prefix.length, prefix.length + '{{char}}'.length],
            'cbsnest1',
        ])
    })

    it('marks decorators and deprecated placeholders', () => {
        const ranges = getCBSHighlightRanges('@@depth 4 <char>')

        expect(ranges).toContainEqual([[0, '@@depth'.length], 'decorator'])
        expect(ranges).toContainEqual([[10, 16], 'deprecated'])
    })

    it('recognizes current registry syntax and keeps five nesting colors', () => {
        const text = '{{#when::{{#each::{{#puredisplay::{{#escape::{{char}}}}}}}}}}}}'
        const types = new Set(getCBSHighlightRanges(text).map(([, type]) => type))

        expect([...types]).toEqual(expect.arrayContaining([
            'cbsnest0',
            'cbsnest1',
            'cbsnest2',
            'cbsnest3',
            'cbsnest4',
        ]))
    })

    it('keeps supported legacy block syntax without a strike-through', () => {
        const ranges = getCBSHighlightRanges('{{#if condition}}value{{/if}}')

        expect(ranges.some(([, type]) => type === 'deprecated')).toBe(false)
        expect(ranges).toContainEqual([[0, '{{#if condition}}'.length], 'cbsnest1'])
    })

    it('assigns nested opening braces to the nested token', () => {
        const text = '{{#if {{? {{getglobalvar::toggle_model}}=3}}}}'
        const ranges = getCBSHighlightRanges(text)

        expect(ranges).toEqual(expect.arrayContaining([
            [[0, 6], 'cbsnest1'],
            [[6, 10], 'cbsnest2'],
            [[10, 40], 'cbsnest3'],
            [[40, 44], 'cbsnest2'],
            [[44, 46], 'cbsnest1'],
        ]))
    })
})

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
})

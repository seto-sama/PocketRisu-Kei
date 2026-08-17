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
})

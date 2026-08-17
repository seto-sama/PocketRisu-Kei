import { describe, expect, it } from 'vitest'
import { getPhysicalPixelQuantum, snapCssLengthToPhysicalPixel } from './physicalPixel'

describe('physical pixel helpers', () => {
    it('uses one physical pixel as the CSS length quantum', () => {
        expect(getPhysicalPixelQuantum(1)).toBe(1)
        expect(getPhysicalPixelQuantum(1.2)).toBeCloseTo(5 / 6)
        expect(getPhysicalPixelQuantum(Number.NaN)).toBe(1)
    })

    it('snaps animated CSS lengths to whole physical pixels', () => {
        const snapped = snapCssLengthToPhysicalPixel(52.25, 1.2)
        expect(snapped * 1.2).toBeCloseTo(Math.round(52.25 * 1.2))
    })
})

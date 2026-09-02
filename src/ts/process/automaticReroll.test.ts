import { describe, expect, it, vi } from 'vitest'
import { normalizeGenerationCount, runAutomaticRerolls } from './automaticReroll'

describe('automatic main rerolls', () => {
    it('normalizes persisted generation counts to the supported range', () => {
        expect(normalizeGenerationCount(0)).toBe(1)
        expect(normalizeGenerationCount(3.9)).toBe(3)
        expect(normalizeGenerationCount(99)).toBe(16)
    })

    it('runs normal rerolls sequentially for the remaining generation count', async () => {
        let active = 0
        let maxActive = 0
        const reroll = vi.fn(async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            await Promise.resolve()
            active -= 1
            return { generated: true, toolExecuted: false, detached: false }
        })

        await runAutomaticRerolls(4, reroll)

        expect(reroll).toHaveBeenCalledTimes(3)
        expect(maxActive).toBe(1)
    })

    it.each([
        { generated: false, toolExecuted: false, detached: false },
        { generated: true, toolExecuted: true, detached: false },
        { generated: true, toolExecuted: false, detached: true },
    ])('stops after a failed, tool-using, or detached reroll', async result => {
        const reroll = vi.fn(async () => result)

        await runAutomaticRerolls(16, reroll)

        expect(reroll).toHaveBeenCalledTimes(1)
    })
})

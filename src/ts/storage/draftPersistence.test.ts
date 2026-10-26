import { describe, expect, it, vi } from 'vitest'
import { createDebouncedDraftWriter } from './draftPersistence'

describe('createDebouncedDraftWriter', () => {
    it('coalesces scheduled drafts and writes only the latest value', async () => {
        vi.useFakeTimers()
        const write = vi.fn(async (_value: string) => {})
        const writer = createDebouncedDraftWriter(write, 250)

        writer.schedule('first')
        writer.schedule('latest')
        await vi.advanceTimersByTimeAsync(249)
        expect(write).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1)
        expect(write).toHaveBeenCalledOnce()
        expect(write).toHaveBeenCalledWith('latest')
        vi.useRealTimers()
    })

    it('flushes immediately and cancels the pending scheduled write', async () => {
        vi.useFakeTimers()
        const write = vi.fn(async (_value: string) => {})
        const writer = createDebouncedDraftWriter(write, 250)

        writer.schedule('stale')
        await writer.flush('current')
        await vi.runAllTimersAsync()

        expect(write).toHaveBeenCalledOnce()
        expect(write).toHaveBeenCalledWith('current')
        vi.useRealTimers()
    })

    it('contains synchronous storage failures in a scheduled save', async () => {
        vi.useFakeTimers()
        const write = vi.fn((_value: string) => {
            throw new Error('storage unavailable')
        })
        const writer = createDebouncedDraftWriter(write, 250)

        writer.schedule('draft')
        // A failure escaping the timer callback would reject here.
        await vi.advanceTimersByTimeAsync(250)
        expect(write).toHaveBeenCalledWith('draft')
        expect(vi.getTimerCount()).toBe(0)
        vi.useRealTimers()
    })
})

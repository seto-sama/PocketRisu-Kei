import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startIdleLock } from './privacyGuardIdleLock'

const minute = 60_000

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it('locks once after the idle period, counting input and busy work as activity', () => {
    let busy = false
    const lock = vi.fn()
    startIdleLock({ getMinutes: () => 10, isBusy: () => busy, lock })

    vi.advanceTimersByTime(9 * minute)
    window.dispatchEvent(new KeyboardEvent('keydown'))
    vi.advanceTimersByTime(9 * minute)
    busy = true
    vi.advanceTimersByTime(30 * minute)
    busy = false
    vi.advanceTimersByTime(9 * minute)
    expect(lock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2 * minute)
    expect(lock).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(30 * minute)
    expect(lock).toHaveBeenCalledOnce()
})

it('never locks while the idle lock is turned off', () => {
    const lock = vi.fn()
    startIdleLock({ getMinutes: () => -1000, isBusy: () => false, lock })
    vi.advanceTimersByTime(24 * 60 * minute)
    expect(lock).not.toHaveBeenCalled()
})

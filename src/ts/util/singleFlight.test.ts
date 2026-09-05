import { describe, expect, it, vi } from 'vitest'
import { createSingleFlightRunner } from './singleFlight'

describe('createSingleFlightRunner', () => {
    it('coalesces a pending action by key and releases it after completion', async () => {
        let resolveAction: (() => void) | undefined
        const action = vi.fn(() => new Promise<void>((resolve) => {
            resolveAction = resolve
        }))
        const run = createSingleFlightRunner('test')

        run('delete', action)
        run('delete', action)
        await Promise.resolve()
        expect(action).toHaveBeenCalledTimes(1)

        resolveAction?.()
        await vi.waitFor(() => {
            run('delete', action)
            expect(action).toHaveBeenCalledTimes(2)
        })
    })

    it('allows unrelated actions to run concurrently', async () => {
        const action = vi.fn(async () => {})
        const run = createSingleFlightRunner('test')

        run('delete', action)
        run('download', action)
        await Promise.resolve()
        expect(action).toHaveBeenCalledTimes(2)
    })
})

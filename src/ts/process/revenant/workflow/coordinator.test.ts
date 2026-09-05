import { describe, expect, test, vi } from 'vitest'
import {
    coordinateRevenantGeneration,
    type RevenantGenerationLifecycle,
} from './coordinator'

describe('coordinateRevenantGeneration', () => {
    test('exposes durable registration before the provider result', async () => {
        let finish!: (value: string) => void
        const onJobCreated = vi.fn()
        const onProviderStarted = vi.fn()
        const providerResult = new Promise<string>(resolve => {
            finish = resolve
        })
        const coordinated = coordinateRevenantGeneration(async lifecycle => {
            lifecycle.onJobCreated('job-1', 1000)
            lifecycle.onProviderStarted(1234)
            return providerResult
        }, { onJobCreated, onProviderStarted })

        await expect(coordinated.registered).resolves.toBe('job-1')
        expect(onJobCreated).toHaveBeenCalledWith('job-1', 1000)
        expect(onProviderStarted).toHaveBeenCalledOnce()
        expect(onProviderStarted).toHaveBeenCalledWith(1234)
        finish('done')
        await expect(coordinated.result).resolves.toBe('done')
    })

    test('reports no durable owner when preparation finishes before registration', async () => {
        const coordinated = coordinateRevenantGeneration(async () => 'not-dispatched')

        await expect(coordinated.registered).resolves.toBeUndefined()
        await expect(coordinated.result).resolves.toBe('not-dispatched')
    })

    test('releases registration wait when preparation throws', async () => {
        const coordinated = coordinateRevenantGeneration(async () => {
            throw new Error('prepare failed')
        })

        await expect(coordinated.registered).resolves.toBeUndefined()
        await expect(coordinated.result).rejects.toThrow('prepare failed')
    })

    test('keeps a streaming registration open until the transport settles it', async () => {
        let lifecycle!: Required<RevenantGenerationLifecycle>
        const coordinated = coordinateRevenantGeneration(async nextLifecycle => {
            lifecycle = nextLifecycle
            return 'stream'
        }, {
            resultKeepsRegistrationOpen: result => result === 'stream',
        })
        const settled = vi.fn()
        void coordinated.registered.then(settled)

        await coordinated.result
        await Promise.resolve()
        expect(settled).not.toHaveBeenCalled()

        lifecycle.onJobRegistrationUnavailable(new Error('proxy unavailable'))
        await expect(coordinated.registered).resolves.toBeUndefined()
    })

    test('accepts durable registration after a streaming handle is returned', async () => {
        let lifecycle!: Required<RevenantGenerationLifecycle>
        const coordinated = coordinateRevenantGeneration(async nextLifecycle => {
            lifecycle = nextLifecycle
            return 'stream'
        }, {
            resultKeepsRegistrationOpen: result => result === 'stream',
        })

        await expect(coordinated.result).resolves.toBe('stream')
        lifecycle.onJobCreated('job-late', 2000)

        await expect(coordinated.registered).resolves.toBe('job-late')
    })
})

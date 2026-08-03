import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createRevenantWorkflowUpdateWaiter,
    emitRevenantWorkflowSyncReady,
    emitRevenantWorkflowUpdate,
    subscribeRevenantWorkflowUpdates,
} from './workflowEvents'

afterEach(() => {
    vi.useRealTimers()
})

describe('revenant workflow update events', () => {
    it('notifies current subscribers and stops after unsubscribe', () => {
        const listener = vi.fn()
        const unsubscribe = subscribeRevenantWorkflowUpdates(listener)
        const event = {
            workflowId: 'workflow-1',
            characterId: 'character-1',
            roomId: 'room-1',
            status: 'active' as const,
        }

        emitRevenantWorkflowUpdate(event)
        unsubscribe()
        emitRevenantWorkflowUpdate({ ...event, status: 'completed' })

        expect(listener).toHaveBeenCalledOnce()
        expect(listener).toHaveBeenCalledWith(event)
    })

    it('wakes a workflow waiter from a matching push event or socket reconnect', async () => {
        vi.useFakeTimers()
        const matching = createRevenantWorkflowUpdateWaiter('workflow-match')
        emitRevenantWorkflowUpdate({
            workflowId: 'workflow-other',
            characterId: 'character-1',
            roomId: 'room-1',
            status: 'active',
        })
        let resolved = false
        void matching.promise.then(() => { resolved = true })
        await Promise.resolve()
        expect(resolved).toBe(false)

        emitRevenantWorkflowUpdate({
            workflowId: 'workflow-match',
            characterId: 'character-1',
            roomId: 'room-1',
            status: 'completed',
        })
        await matching.promise
        expect(resolved).toBe(true)

        const reconnect = createRevenantWorkflowUpdateWaiter('workflow-reconnect')
        emitRevenantWorkflowSyncReady()
        await expect(reconnect.promise).resolves.toBeUndefined()
    })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createRevenantWorkflowUpdateWaiter,
    emitRevenantWorkflowSyncReady,
    emitRevenantWorkflowUpdate,
} from './workflowEvents'

afterEach(() => {
    vi.useRealTimers()
})

describe('revenant workflow update events', () => {
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

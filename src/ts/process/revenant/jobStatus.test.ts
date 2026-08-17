import { beforeEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import { requestStatuses } from '../../status/requestStatus'
import {
    bindRevenantTerminalOutcome,
    finishRevenantJobRequestStatus,
    finishRevenantWorkflowRequestStatuses,
    registerRevenantRequestStatus,
    resetRevenantRequestStatusSessionsForTest,
    resolveRevenantTerminalRequestOutcome,
    revenantTerminalRequestOutcome,
} from './jobStatus'

beforeEach(() => {
    requestStatuses.set(new Map())
    resetRevenantRequestStatusSessionsForTest()
})

describe('revenantTerminalRequestOutcome', () => {
    it('uses one durable terminal classification for live and recovered requests', () => {
        expect(revenantTerminalRequestOutcome('generated')).toBe('done')
        expect(revenantTerminalRequestOutcome('cancelled')).toBe('aborted')
        expect(revenantTerminalRequestOutcome('interrupted')).toBe('failed')
        expect(revenantTerminalRequestOutcome('failed_partial')).toBe('failed')
        expect(revenantTerminalRequestOutcome('failed')).toBe('failed')
        expect(revenantTerminalRequestOutcome('generating')).toBeUndefined()
    })

    it('lets the durable server downgrade clean EOF without masking local failures', () => {
        expect(resolveRevenantTerminalRequestOutcome('done', 'cancelled')).toBe('aborted')
        expect(resolveRevenantTerminalRequestOutcome('done', 'failed_partial')).toBe('failed')
        expect(resolveRevenantTerminalRequestOutcome('failed', 'generated')).toBe('failed')
    })

    it('composes the caller terminal hook with the shared outcome resolver', () => {
        let observed = ''
        const target = {
            onRevenantTerminal: (terminal: any) => { observed = terminal.status },
        }
        const lifecycle = bindRevenantTerminalOutcome(target)

        target.onRevenantTerminal({ status: 'cancelled' } as any)

        expect(observed).toBe('cancelled')
        expect(lifecycle.resolve('done')).toBe('aborted')
    })

    it('uses the same job session for live and reattached terminal observation', () => {
        registerRevenantRequestStatus({
            jobId: 'job-1',
            statusId: 'message-1',
            workflowId: 'workflow-1',
            roomId: 'room-1',
            kind: 'main',
            label: 'model',
            startedAt: 10,
        })

        finishRevenantJobRequestStatus(
            'job-1',
            { status: 'generated' },
            undefined,
            { responseTokens: 17 },
        )

        expect(get(requestStatuses).get('message-1')).toMatchObject({
            phase: 'done',
            label: 'model',
            responseTokens: 17,
        })
    })

    it('applies a workflow terminal fallback to a job observer registered late', () => {
        finishRevenantWorkflowRequestStatuses({
            workflowId: 'workflow-fast',
            roomId: 'room-1',
            outcome: 'done',
            endedAt: 20,
        })

        registerRevenantRequestStatus({
            jobId: 'job-fast',
            statusId: 'message-fast',
            workflowId: 'workflow-fast',
            roomId: 'room-1',
            kind: 'main',
            startedAt: 10,
        })

        expect(get(requestStatuses).get('message-fast')).toMatchObject({
            phase: 'done',
            endedAt: 20,
        })
    })
})

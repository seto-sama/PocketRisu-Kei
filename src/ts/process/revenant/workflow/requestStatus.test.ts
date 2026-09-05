import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { requestStatuses } from '../../../status/requestStatus'
import { resetRevenantRequestStatusSessionsForTest } from '../jobStatus'
import { observeRevenantWorkflowRequests } from './requestStatus'

const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }))
vi.mock('../../../storage/database.svelte', () => ({ getDatabase: () => ({ showRequestStatus: true }) }))
vi.mock('./workflow', () => ({ getRevenantWorkflowRequestStatus: mocks.snapshot }))

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    requestStatuses.set(new Map())
    resetRevenantRequestStatusSessionsForTest()
    vi.resetAllMocks()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

const job = (id: string, jobType: string, status: string) => ({
    jobId: id, chatId: id, workflowId: 'workflow', roomId: 'room', jobType, status,
    generationInfo: { model: id + ' model' }, createdAt: 10, dispatchedAt: 20,
})

describe('workflow request status', () => {
    it('closes pending request toasts when workflow cancellation precedes job shutdown', async () => {
        mocks.snapshot.mockResolvedValueOnce({ roomId: 'room', status: 'active', jobs: [job('main', 'model', 'generating')] })
            .mockResolvedValue({ roomId: 'room', status: 'cancelled', jobs: [job('main', 'model', 'generating')] })
        observeRevenantWorkflowRequests('workflow')
        await vi.advanceTimersByTimeAsync(500)
        expect(get(requestStatuses).get('main')?.phase).toBe('aborted')
    })

    it.each(['generated', 'failed', 'cancelled'] as const)('follows Hypa, main and auxiliary requests through %s in one snapshot', async terminal => {
        mocks.snapshot.mockResolvedValueOnce({ roomId: 'room', status: 'active', jobs: [
            job('hypa', 'memory', 'generating'), job('main', 'model', 'queued'),
        ] }).mockResolvedValueOnce({ roomId: 'room', status: 'active', jobs: [
            job('hypa', 'memory', 'generated'), job('main', 'model', 'generating'),
        ] }).mockResolvedValueOnce({ roomId: 'room', status: 'active', jobs: [
            job('hypa', 'memory', 'generated'), job('main', 'model', 'generated'),
            job('aux', 'submodel', 'generating'),
        ] }).mockResolvedValue({ roomId: 'room', status: terminal === 'generated' ? 'completed' : terminal, jobs: [
            job('hypa', 'memory', 'generated'), job('main', 'model', 'generated'),
            job('aux', 'submodel', terminal),
        ] })
        observeRevenantWorkflowRequests('workflow')
        observeRevenantWorkflowRequests('workflow')
        await vi.advanceTimersByTimeAsync(0)
        expect([...get(requestStatuses).keys()]).toEqual(['hypa'])
        expect(get(requestStatuses).get('hypa')).toMatchObject({ kind: 'memory', label: 'hypa model', phase: 'connecting' })
        await vi.advanceTimersByTimeAsync(500)
        expect(get(requestStatuses).get('hypa')?.phase).toBe('done')
        expect(get(requestStatuses).get('main')).toMatchObject({ kind: 'main', phase: 'connecting' })
        await vi.advanceTimersByTimeAsync(500)
        expect(get(requestStatuses).get('main')?.phase).toBe('done')
        expect(get(requestStatuses).get('aux')).toMatchObject({ kind: 'sub', phase: 'connecting' })
        await vi.advanceTimersByTimeAsync(500)
        expect(get(requestStatuses).get('aux')?.phase).toBe(
            terminal === 'generated' ? 'done' : terminal === 'cancelled' ? 'aborted' : 'failed',
        )
        await vi.advanceTimersByTimeAsync(1000)
        expect(mocks.snapshot).toHaveBeenCalledTimes(4)
        expect(mocks.snapshot).toHaveBeenLastCalledWith('workflow', undefined)
    })
})

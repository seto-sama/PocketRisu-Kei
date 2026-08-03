import { describe, expect, it, vi } from 'vitest'
import servicePkg from './generationWorkflowService.cjs'

const { createGenerationWorkflowService } = servicePkg as {
    createGenerationWorkflowService: (options: Record<string, unknown>) => {
        terminateWorkflow: (workflowId: string, status: string) => Promise<{
            changed: boolean
            jobs: Array<{ jobId: string, status: string }>
        }>
    }
}

describe('generation workflow service', () => {
    it('cancels every queued/running child and waits for upstream shutdown', async () => {
        let settleRunning!: () => void
        const queuedController = new AbortController()
        const runningController = new AbortController()
        const queuedAbort = vi.spyOn(queuedController, 'abort')
        const runningAbort = vi.spyOn(runningController, 'abort')
        const queued = {
            done: false,
            terminalEvent: null as unknown,
            abortController: queuedController,
        }
        const running = {
            done: false,
            runPromise: new Promise<void>(resolve => { settleRunning = resolve }),
            abortController: runningController,
            cancelUpstream: vi.fn(() => Promise.resolve()),
        }
        const markJobDone = vi.fn((job: any) => { job.done = true })
        const abortHypaWorkflowExecution = vi.fn()
        const service = createGenerationWorkflowService({
            finishGenerationWorkflow: vi.fn(),
            cancelGenerationWorkflow: vi.fn(() => ({
                changed: true,
                jobs: [
                    { jobId: 'queued', status: 'queued' },
                    { jobId: 'running', status: 'generating' },
                ],
            })),
            proxyStreamJobs: new Map([
                ['queued', queued],
                ['running', running],
            ]),
            markJobDone,
            abortHypaWorkflowExecution,
        })

        let terminationSettled = false
        const termination = service.terminateWorkflow('workflow-1', 'cancelled')
            .then(result => {
                terminationSettled = true
                return result
            })
        await Promise.resolve()

        expect(terminationSettled).toBe(false)
        expect(abortHypaWorkflowExecution).toHaveBeenCalledWith('workflow-1')
        expect(queuedAbort).toHaveBeenCalledOnce()
        expect(runningAbort).toHaveBeenCalledOnce()
        expect(running.cancelUpstream).toHaveBeenCalledOnce()
        expect(queued.terminalEvent).toMatchObject({
            type: 'done',
            finishReason: 'workflow_cancelled',
        })
        expect(markJobDone).toHaveBeenCalledWith(queued)
        expect(markJobDone).not.toHaveBeenCalledWith(running)

        settleRunning()
        expect((await termination).changed).toBe(true)
    })

    it('finishes completed workflows without cancelling children', async () => {
        const finishGenerationWorkflow = vi.fn(() => true)
        const cancelGenerationWorkflow = vi.fn()
        const service = createGenerationWorkflowService({
            finishGenerationWorkflow,
            cancelGenerationWorkflow,
            proxyStreamJobs: new Map(),
            markJobDone: vi.fn(),
        })

        await expect(service.terminateWorkflow('workflow-1', 'completed')).resolves.toEqual({
            changed: true,
            jobs: [],
        })
        expect(finishGenerationWorkflow).toHaveBeenCalledWith('workflow-1', 'completed')
        expect(cancelGenerationWorkflow).not.toHaveBeenCalled()
    })
})

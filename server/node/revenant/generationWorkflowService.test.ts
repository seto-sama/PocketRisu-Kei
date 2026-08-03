import { describe, expect, it, vi } from 'vitest'
import servicePkg from './generationWorkflowService.cjs'

const { createGenerationWorkflowService } = servicePkg as {
    createGenerationWorkflowService: (options: Record<string, unknown>) => {
        terminateWorkflow: (workflowId: string, status: string) => Promise<{
            changed: boolean
            jobs: Array<{ jobId: string, status: string }>
        }>
        cancelStepExecution: (workflowId: string, executionId: string) => Promise<{
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
        const markGenerationJobDone = vi.fn((job: any) => { job.done = true })
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
            generationRuntimeJobs: new Map([
                ['queued', queued],
                ['running', running],
            ]),
            markGenerationJobDone,
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
        expect(markGenerationJobDone).toHaveBeenCalledWith(queued)
        expect(markGenerationJobDone).not.toHaveBeenCalledWith(running)

        settleRunning()
        expect((await termination).changed).toBe(true)
    })

    it('finishes completed workflows without cancelling children', async () => {
        const finishGenerationWorkflow = vi.fn(() => true)
        const cancelGenerationWorkflow = vi.fn()
        const service = createGenerationWorkflowService({
            finishGenerationWorkflow,
            cancelGenerationWorkflow,
            generationRuntimeJobs: new Map(),
            markGenerationJobDone: vi.fn(),
        })

        await expect(service.terminateWorkflow('workflow-1', 'completed')).resolves.toEqual({
            changed: true,
            jobs: [],
        })
        expect(finishGenerationWorkflow).toHaveBeenCalledWith('workflow-1', 'completed')
        expect(cancelGenerationWorkflow).not.toHaveBeenCalled()
    })

    it('cancels only jobs owned by the selected step execution', async () => {
        const controller = new AbortController()
        const job = {
            done: false,
            terminalEvent: null as unknown,
            abortController: controller,
        }
        const markGenerationJobDone = vi.fn((target: any) => { target.done = true })
        const cancelGenerationStepExecution = vi.fn(() => ({
            changed: true,
            jobs: [{ jobId: 'step-job', status: 'queued' }],
        }))
        const service = createGenerationWorkflowService({
            finishGenerationWorkflow: vi.fn(),
            cancelGenerationWorkflow: vi.fn(),
            cancelGenerationStepExecution,
            generationRuntimeJobs: new Map([['step-job', job]]),
            markGenerationJobDone,
        })

        await expect(service.cancelStepExecution('workflow-1', 'execution-1'))
            .resolves.toMatchObject({ changed: true })
        expect(cancelGenerationStepExecution)
            .toHaveBeenCalledWith('workflow-1', 'execution-1')
        expect(job.terminalEvent).toMatchObject({
            type: 'done',
            finishReason: 'step_cancelled',
        })
        expect(markGenerationJobDone).toHaveBeenCalledWith(job)
    })
})

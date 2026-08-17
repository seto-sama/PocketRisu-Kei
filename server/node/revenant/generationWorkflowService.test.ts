import { describe, expect, it, vi } from 'vitest'
import servicePkg from './generationWorkflowService.cjs'

const {
    createGenerationJobCancellationService,
    createGenerationWorkflowService,
} = servicePkg as {
    createGenerationJobCancellationService: (options: Record<string, unknown>) => {
        cancel: (jobId: string) => Promise<any>
    }
    createGenerationWorkflowService: (options: Record<string, unknown>) => {
        terminateWorkflow: (workflowId: string, status: string) => Promise<{
            changed: boolean
            jobs: Array<{ jobId: string, status: string }>
        }>
        cancelStepExecution: (workflowId: string, executionId: string) => Promise<{
            changed: boolean
            jobs: Array<{ jobId: string, status: string }>
        }>
        commitInput: (workflow: any, input: any, request?: any) => Promise<any>
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
        const materializeCancelledWorkflow = vi.fn(async () => {})
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
            materializeCancelledWorkflow,
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
            status: 'cancelled',
            finishReason: 'workflow_cancelled',
        })
        expect(markGenerationJobDone).toHaveBeenCalledWith(queued)
        expect(markGenerationJobDone).not.toHaveBeenCalledWith(running)

        settleRunning()
        expect((await termination).changed).toBe(true)
        expect(materializeCancelledWorkflow).toHaveBeenCalledWith('workflow-1')
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

    it('commits the durable chat input and records its canonical etag before generation', async () => {
        const committedWorkflow = { workflowId: 'workflow-1', status: 'active' }
        const commitWorkflowInput = vi.fn(async () => ({ etag: 'committed-etag' }))
        const updateGenerationWorkflowStep = vi.fn()
        const getGenerationWorkflow = vi.fn(() => committedWorkflow)
        const service = createGenerationWorkflowService({
            finishGenerationWorkflow: vi.fn(),
            cancelGenerationWorkflow: vi.fn(),
            generationRuntimeJobs: new Map(),
            markGenerationJobDone: vi.fn(),
            commitWorkflowInput,
            updateGenerationWorkflowStep,
            getGenerationWorkflow,
        })
        const workflow = {
            workflowId: 'workflow-1', characterId: 'character-1', roomId: 'room-1',
            steps: [{ key: 'input.commit', status: 'pending' }],
        }
        const input = {
            schemaVersion: 1,
            chat: { id: 'room-1', message: [{ role: 'user', data: 'durable input' }] },
            expectedEtag: 'previous-etag',
        }
        await expect(service.commitInput(workflow, input)).resolves.toBe(committedWorkflow)
        expect(commitWorkflowInput).toHaveBeenCalledWith({
            workflowId: 'workflow-1',
            characterId: 'character-1',
            roomId: 'room-1',
            input,
        })
        expect(updateGenerationWorkflowStep).toHaveBeenCalledWith(
            'workflow-1',
            'input.commit',
            { status: 'completed', metadata: { schemaVersion: 1, etag: 'committed-etag' } },
        )
    })

    it('fails the workflow when its input commit conflicts', async () => {
        const conflict = Object.assign(new Error('input conflict'), { httpStatus: 409 })
        const updateGenerationWorkflowStep = vi.fn()
        const cancelGenerationWorkflow = vi.fn(() => ({ changed: true, jobs: [] }))
        const publishCanonicalWorkflowChat = vi.fn(async () => true)
        const service = createGenerationWorkflowService({
            finishGenerationWorkflow: vi.fn(),
            cancelGenerationWorkflow,
            generationRuntimeJobs: new Map(),
            markGenerationJobDone: vi.fn(),
            commitWorkflowInput: vi.fn(async () => { throw conflict }),
            updateGenerationWorkflowStep,
            publishCanonicalWorkflowChat,
        })
        const workflow = {
            workflowId: 'workflow-1', characterId: 'character-1', roomId: 'room-1',
            steps: [{ key: 'input.commit', status: 'pending' }],
        }

        await expect(service.commitInput(workflow, {
            schemaVersion: 1, chat: { id: 'room-1', message: [] },
        })).rejects.toBe(conflict)
        expect(updateGenerationWorkflowStep).toHaveBeenCalledWith(
            'workflow-1',
            'input.commit',
            { status: 'failed', metadata: { error: 'input conflict' } },
        )
        expect(cancelGenerationWorkflow).toHaveBeenCalledWith('workflow-1', 'failed')
        expect(publishCanonicalWorkflowChat).toHaveBeenCalledWith('workflow-1')
    })
})

describe('generation job cancellation service', () => {
    it('routes workflow-owned model cancellation through workflow materialization', async () => {
        const workflow = { workflowId: 'workflow-1', status: 'cancelled' }
        const repository = {
            getGenerationJob: vi.fn(() => ({
                jobId: 'job-1', jobType: 'model', workflowId: 'workflow-1',
            })),
            getGenerationWorkflow: vi.fn(() => workflow),
            finishGenerationJob: vi.fn(),
            markGenerationMaterialized: vi.fn(),
        }
        const terminateGenerationWorkflow = vi.fn(async () => ({ changed: true }))
        const notifyRevenantWorkflowUpdated = vi.fn()
        const service = createGenerationJobCancellationService({
            repository,
            generationRuntimeJobs: new Map(),
            terminateGenerationWorkflow,
            notifyRevenantWorkflowUpdated,
            isJobActive: () => true,
        })

        await expect(service.cancel('job-1')).resolves.toEqual({
            success: true,
            workflowId: 'workflow-1',
        })
        expect(terminateGenerationWorkflow).toHaveBeenCalledWith('workflow-1', 'cancelled')
        expect(notifyRevenantWorkflowUpdated).toHaveBeenCalledWith(workflow)
        expect(repository.markGenerationMaterialized).not.toHaveBeenCalled()
    })

    it('cancels and consumes standalone jobs without workflow policy in the route', async () => {
        const abort = vi.fn()
        const repository = {
            getGenerationJob: vi.fn(() => ({ jobId: 'job-1', jobType: 'submodel' })),
            getGenerationWorkflow: vi.fn(),
            finishGenerationJob: vi.fn(),
            markGenerationMaterialized: vi.fn(),
        }
        const service = createGenerationJobCancellationService({
            repository,
            generationRuntimeJobs: new Map([['job-1', {
                done: false,
                abortController: { abort },
            }]]),
            terminateGenerationWorkflow: vi.fn(),
            isJobActive: () => true,
        })

        await expect(service.cancel('job-1')).resolves.toEqual({ success: true })
        expect(abort).toHaveBeenCalledOnce()
        expect(repository.finishGenerationJob).toHaveBeenCalledWith(
            'job-1', 'cancelled', 'user_cancelled',
        )
        expect(repository.markGenerationMaterialized).toHaveBeenCalledWith('job-1')
    })
})

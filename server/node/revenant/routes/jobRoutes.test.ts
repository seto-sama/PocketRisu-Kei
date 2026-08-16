// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const repository = vi.hoisted(() => ({
    getGenerationWorkflow: vi.fn(),
    hasGenerationWorkflowClientActionClaim: vi.fn(),
    updateGenerationWorkflowStep: vi.fn(),
    createGenerationJob: vi.fn(),
    getGenerationJob: vi.fn(),
    listGenerationWorkflowJobs: vi.fn(),
    setGenerationJobClientProjection: vi.fn(),
    updateGenerationJobMetadata: vi.fn(),
    finishGenerationJob: vi.fn(),
    listRecoverableGenerationJobs: vi.fn(),
    listRecoverableAuxiliaryJobs: vi.fn(),
    markGenerationMaterialized: vi.fn(),
    pruneRetainedGenerationJobs: vi.fn(),
}))

vi.mock('../generationDb.cjs', () => repository)

const { installRevenantJobRoutes } = await import('./jobRoutes.cjs') as any

describe('generation job cancellation route', () => {
    beforeEach(() => vi.clearAllMocks())

    it('delegates a workflow model job to workflow cancellation without pre-acknowledging it', async () => {
        const routes = new Map<string, Function>()
        const app = {
            get: vi.fn(),
            post: vi.fn(),
            put: vi.fn(),
            delete: vi.fn((path: string, handler: Function) => routes.set(path, handler)),
        }
        repository.getGenerationJob.mockReturnValue({
            jobId: 'job-1',
            jobType: 'model',
            workflowId: 'workflow-1',
            status: 'generating',
        })
        repository.getGenerationWorkflow.mockReturnValue({
            workflowId: 'workflow-1',
            status: 'cancelled',
        })
        const terminateGenerationWorkflow = vi.fn().mockResolvedValue({
            changed: true,
            jobs: [{ jobId: 'job-1' }],
        })
        const notifyRevenantWorkflowUpdated = vi.fn()

        installRevenantJobRoutes(app, {
            checkProxyAuth: vi.fn().mockResolvedValue(true),
            requireSyncClientId: vi.fn(() => true),
            generationRuntimeJobs: new Map(),
            terminateGenerationWorkflow,
            notifyRevenantWorkflowUpdated,
            getGenerationJob: repository.getGenerationJob,
            getGenerationWorkflow: repository.getGenerationWorkflow,
            finishGenerationJob: repository.finishGenerationJob,
            markGenerationMaterialized: repository.markGenerationMaterialized,
        })

        const send = vi.fn()
        const next = vi.fn()
        await routes.get('/api/generation/jobs/:jobId')?.(
            { params: { jobId: 'job-1' } },
            { send },
            next,
        )

        expect(terminateGenerationWorkflow).toHaveBeenCalledWith('workflow-1', 'cancelled')
        expect(repository.markGenerationMaterialized).not.toHaveBeenCalled()
        expect(repository.finishGenerationJob).not.toHaveBeenCalled()
        expect(notifyRevenantWorkflowUpdated).toHaveBeenCalledWith({
            workflowId: 'workflow-1',
            status: 'cancelled',
        })
        expect(send).toHaveBeenCalledWith({ success: true, workflowId: 'workflow-1' })
        expect(next).not.toHaveBeenCalled()
    })

    it('publishes terminal workflow state only after server cancellation settles', async () => {
        const routes = new Map<string, Function>()
        const app = {
            get: vi.fn(),
            post: vi.fn(),
            put: vi.fn(),
            delete: vi.fn((path: string, handler: Function) => routes.set(path, handler)),
        }
        repository.getGenerationJob.mockReturnValue({
            jobId: 'job-1',
            jobType: 'model',
            workflowId: 'workflow-1',
            status: 'generating',
        })
        repository.getGenerationWorkflow.mockReturnValue({
            workflowId: 'workflow-1',
            status: 'cancelled',
        })
        let settleCancellation!: () => void
        const terminateGenerationWorkflow = vi.fn(() => new Promise(resolve => {
            settleCancellation = () => resolve({ changed: true, jobs: [{ jobId: 'job-1' }] })
        }))
        const notifyRevenantWorkflowUpdated = vi.fn()

        installRevenantJobRoutes(app, {
            checkProxyAuth: vi.fn().mockResolvedValue(true),
            requireSyncClientId: vi.fn(() => true),
            generationRuntimeJobs: new Map(),
            terminateGenerationWorkflow,
            notifyRevenantWorkflowUpdated,
            getGenerationJob: repository.getGenerationJob,
            getGenerationWorkflow: repository.getGenerationWorkflow,
            finishGenerationJob: repository.finishGenerationJob,
            markGenerationMaterialized: repository.markGenerationMaterialized,
        })

        const request = routes.get('/api/generation/jobs/:jobId')?.(
            { params: { jobId: 'job-1' } },
            { send: vi.fn() },
            vi.fn(),
        )
        await Promise.resolve()
        expect(notifyRevenantWorkflowUpdated).not.toHaveBeenCalled()

        settleCancellation()
        await request
        expect(notifyRevenantWorkflowUpdated).toHaveBeenCalledOnce()
    })
})

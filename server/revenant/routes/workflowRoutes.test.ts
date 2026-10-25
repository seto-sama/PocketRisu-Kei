import { beforeEach, describe, expect, it, vi } from 'vitest'

const repository = vi.hoisted(() => ({ getGenerationWorkflow: vi.fn(), listGenerationWorkflowJobs: vi.fn() }))
const { installRevenantWorkflowRoutes } = await import('./workflowRoutes.cjs') as any

describe('workflow request status snapshot', () => {
    beforeEach(() => vi.resetAllMocks())

    it('includes consumed jobs from only the requested workflow without provider payloads', async () => {
        const routes = new Map<string, Function>()
        const app = { get: (path: string, handler: Function) => routes.set(path, handler),
            post: vi.fn(), put: vi.fn(), delete: vi.fn() }
        installRevenantWorkflowRoutes(app, { checkProxyAuth: async () => true,
            getWorkflowRequestStatusWorkflow: repository.getGenerationWorkflow,
            getWorkflowRequestStatusJobs: repository.listGenerationWorkflowJobs })
        repository.getGenerationWorkflow.mockReturnValue({ workflowId: 'wf', roomId: 'room', status: 'active' })
        repository.listGenerationWorkflowJobs.mockReturnValue([
            { jobId: 'hypa', jobType: 'memory', status: 'generated', materializedAt: 100,
                generationInfo: { model: 'Summary' }, operationContext: { private: 'data' }, rawResponse: 'private' },
            { jobId: 'main', jobType: 'model', status: 'generating' },
        ])
        const send = vi.fn()
        await routes.get('/api/generation/workflows/:workflowId/request-status')!(
            { params: { workflowId: 'wf' } }, { send },
        )
        expect(repository.listGenerationWorkflowJobs).toHaveBeenCalledExactlyOnceWith('wf')
        const snapshot = send.mock.calls[0][0]
        expect(snapshot).toMatchObject({ workflowId: 'wf', status: 'active', jobs: [
            { jobId: 'hypa', status: 'generated', generationInfo: { model: 'Summary' } },
            { jobId: 'main', status: 'generating' },
        ] })
        expect(snapshot.jobs[0]).not.toHaveProperty('rawResponse')
        expect(snapshot.jobs[0]).not.toHaveProperty('operationContext')
    })
})

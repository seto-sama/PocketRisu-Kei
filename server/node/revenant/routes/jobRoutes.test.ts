// @vitest-environment node
import { encodeGenerationRequest } from '../../../../src/ts/process/revenant/transport/protocol'
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

describe('generation job creation route', () => {
    beforeEach(() => vi.clearAllMocks())

    it('returns the durable creation time used by client timers', async () => {
        const routes = new Map<string, Function>()
        const app = {
            get: vi.fn(),
            post: vi.fn((path: string, ...handlers: Function[]) => routes.set(path, handlers.at(-1)!)),
            put: vi.fn(),
            delete: vi.fn(),
        }
        repository.createGenerationJob.mockReturnValue({
            jobId: 'job-1',
            createdAt: 1234,
        })
        const runGenerationProviderJob = vi.fn().mockResolvedValue(undefined)

        installRevenantJobRoutes(app, {
            checkProxyAuth: vi.fn().mockResolvedValue(true),
            requireSyncClientId: vi.fn(() => true),
            sanitizeGenerationTargetUrl: vi.fn((url: string) => url),
            normalizeForwardHeaders: vi.fn(() => ({})),
            createGenerationRuntimeJob: vi.fn(() => ({ heartbeatSec: 30 })),
            runGenerationProviderJob,
            scheduleGenerationDispatch: vi.fn(),
            scheduleHypaWorkflowExecution: vi.fn(),
            generationRuntimeJobs: new Map(),
            countActiveProviderJobs: vi.fn(() => 0),
            capacity: { maxActiveWorkflows: 5, maxActiveProviderJobs: 10 },
            randomUUID: vi.fn(() => 'job-1'),
            terminateGenerationWorkflow: vi.fn(),
            createGenerationJob: repository.createGenerationJob,
            createSingleGenerationJob: repository.createGenerationJob,
        })
        const send = vi.fn()

        await routes.get('/api/generation/jobs')?.(
            {
                body: Buffer.from(encodeGenerationRequest({
                    url: 'https://provider.example/v1beta/models/gemini-test:generateContent',
                    adapterKind: 'google-gemini',
                    body: Uint8Array.of(0, 255, 128, 10),
                })),
                headers: {},
            },
            { send, status: vi.fn() },
            vi.fn(),
        )

        expect([...runGenerationProviderJob.mock.calls[0][1].body]).toEqual([0, 255, 128, 10])
        expect(send).toHaveBeenCalledWith({
            jobId: 'job-1',
            createdAt: 1234,
            heartbeatSec: 30,
        })
    })
})

describe('generation journal snapshot route', () => {
    beforeEach(() => vi.clearAllMocks())

    it('returns one immutable journal snapshot with its live-tail offset', async () => {
        const routes = new Map<string, Function>()
        const app = {
            get: vi.fn((path: string, ...handlers: Function[]) => routes.set(path, handlers.at(-1)!)),
            post: vi.fn(), put: vi.fn(), delete: vi.fn(),
        }
        const bytes = Buffer.from('already received')
        repository.getGenerationJob.mockReturnValue({
            jobId: 'job-1', workflowId: 'workflow-1', status: 'generating',
        })
        const readAll = vi.fn(() => bytes)
        installRevenantJobRoutes(app, {
            checkProxyAuth: vi.fn().mockResolvedValue(true),
            requireSyncClientId: vi.fn(() => true),
            generationRuntimeJobs: new Map(),
            terminateGenerationWorkflow: vi.fn(),
            getGenerationJob: repository.getGenerationJob,
            generationJournalStore: { readAll },
        })
        const set = vi.fn()
        const send = vi.fn()

        await routes.get('/api/generation/jobs/:jobId/journal/snapshot')?.(
            { params: { jobId: 'job-1' } },
            { set, send, status: vi.fn() },
        )

        expect(readAll).toHaveBeenCalledWith('workflow-1', 'job-1')
        expect(set).toHaveBeenCalledWith('x-risu-journal-offset', String(bytes.length))
        expect(send).toHaveBeenCalledWith(bytes)
    })
})

describe('generation job cancellation route', () => {
    beforeEach(() => vi.clearAllMocks())

    it('delegates a workflow model job to workflow cancellation without pre-acknowledging it', async () => {
        const routes = new Map<string, Function>()
        const app = {
            get: vi.fn(),
            post: vi.fn(),
            put: vi.fn(),
            delete: vi.fn((path: string, ...handlers: Function[]) => routes.set(path, handlers.at(-1)!)),
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
            delete: vi.fn((path: string, ...handlers: Function[]) => routes.set(path, handlers.at(-1)!)),
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

    it('allows a caller-owned standalone main job to be consumed', async () => {
        const routes = new Map<string, Function>()
        const app = {
            get: vi.fn(),
            post: vi.fn((path: string, ...handlers: Function[]) => routes.set(path, handlers.at(-1)!)),
            put: vi.fn(),
            delete: vi.fn(),
        }
        repository.getGenerationJob.mockReturnValue({
            jobId: 'job-1',
            jobType: 'model',
            status: 'generated',
        })
        repository.markGenerationMaterialized.mockReturnValue(true)

        installRevenantJobRoutes(app, {
            checkProxyAuth: vi.fn().mockResolvedValue(true),
            requireSyncClientId: vi.fn(() => true),
            generationRuntimeJobs: new Map(),
            terminateGenerationWorkflow: vi.fn(),
            getGenerationJob: repository.getGenerationJob,
            markGenerationMaterialized: repository.markGenerationMaterialized,
        })

        const send = vi.fn()
        await routes.get('/api/generation/jobs/:jobId/consume')?.(
            { params: { jobId: 'job-1' } },
            { send, status: vi.fn() },
        )

        expect(repository.markGenerationMaterialized).toHaveBeenCalledWith('job-1')
        expect(send).toHaveBeenCalledWith({ success: true })
    })

    it('keeps workflow-owned main jobs behind canonical materialization', async () => {
        const routes = new Map<string, Function>()
        const app = {
            get: vi.fn(),
            post: vi.fn((path: string, ...handlers: Function[]) => routes.set(path, handlers.at(-1)!)),
            put: vi.fn(),
            delete: vi.fn(),
        }
        repository.getGenerationJob.mockReturnValue({
            jobId: 'job-1',
            jobType: 'model',
            workflowId: 'workflow-1',
            status: 'generated',
        })
        repository.getGenerationWorkflow.mockReturnValue({
            workflowId: 'workflow-1',
            status: 'active',
        })

        installRevenantJobRoutes(app, {
            checkProxyAuth: vi.fn().mockResolvedValue(true),
            requireSyncClientId: vi.fn(() => true),
            generationRuntimeJobs: new Map(),
            terminateGenerationWorkflow: vi.fn(),
            getGenerationJob: repository.getGenerationJob,
            markGenerationMaterialized: repository.markGenerationMaterialized,
        })

        const send = vi.fn()
        const status = vi.fn(() => ({ send }))
        await routes.get('/api/generation/jobs/:jobId/consume')?.(
            { params: { jobId: 'job-1' } },
            { send, status },
        )

        expect(status).toHaveBeenCalledWith(400)
        expect(repository.markGenerationMaterialized).not.toHaveBeenCalled()
    })

    it('allows an abandoned job from a terminal failed workflow to be acknowledged', async () => {
        const routes = new Map<string, Function>()
        const app = {
            get: vi.fn(),
            post: vi.fn((path: string, ...handlers: Function[]) => routes.set(path, handlers.at(-1)!)),
            put: vi.fn(),
            delete: vi.fn(),
        }
        repository.getGenerationJob.mockReturnValue({
            jobId: 'job-1',
            jobType: 'model',
            workflowId: 'workflow-1',
            status: 'generated',
        })
        repository.getGenerationWorkflow.mockReturnValue({
            workflowId: 'workflow-1',
            status: 'cancelled',
        })
        repository.markGenerationMaterialized.mockReturnValue(true)

        installRevenantJobRoutes(app, {
            checkProxyAuth: vi.fn().mockResolvedValue(true),
            requireSyncClientId: vi.fn(() => true),
            generationRuntimeJobs: new Map(),
            terminateGenerationWorkflow: vi.fn(),
            getGenerationJob: repository.getGenerationJob,
            getGenerationWorkflow: repository.getGenerationWorkflow,
            markGenerationMaterialized: repository.markGenerationMaterialized,
        })

        const send = vi.fn()
        await routes.get('/api/generation/jobs/:jobId/consume')?.(
            { params: { jobId: 'job-1' } },
            { send, status: vi.fn() },
        )

        expect(repository.markGenerationMaterialized).toHaveBeenCalledWith('job-1')
        expect(send).toHaveBeenCalledWith({ success: true })
    })
})

describe('provider generation projection route', () => {
    beforeEach(() => vi.clearAllMocks())

    function installProjectionRoute(job: any, workflow: any, generationRuntimeJobs = new Map()) {
        const routes = new Map<string, Function>()
        const app = {
            get: vi.fn(), post: vi.fn(),
            put: vi.fn((path: string, ...handlers: Function[]) => routes.set(path, handlers.at(-1)!)),
            delete: vi.fn(),
        }
        repository.getGenerationJob.mockReturnValue(job)
        repository.getGenerationWorkflow.mockReturnValue(workflow)
        const scheduleRevenantPostprocess = vi.fn()
        installRevenantJobRoutes(app, {
            checkProxyAuth: vi.fn().mockResolvedValue(true),
            requireSyncClientId: vi.fn(() => true),
            generationRuntimeJobs,
            terminateGenerationWorkflow: vi.fn(),
            getGenerationJob: repository.getGenerationJob,
            getGenerationWorkflow: repository.getGenerationWorkflow,
            setGenerationJobClientProjection: repository.setGenerationJobClientProjection,
            scheduleRevenantPostprocess,
        })
        return { handler: routes.get('/api/generation/jobs/:jobId/projection'), scheduleRevenantPostprocess }
    }

    const pendingJob = {
        jobId: 'job-1',
        jobType: 'model',
        workflowId: 'workflow-1',
        workflowStepKey: 'model.main',
        status: 'generated',
        materializedAt: null,
        adapterKind: 'openai-compatible',
        rawBytes: 123,
        projection: {
            source: 'server',
            adapterKind: 'openai-compatible',
            journalBytes: 123,
            awaitingProviderResult: true,
        },
    }
    const providerWorkflow = {
        workflowId: 'workflow-1',
        status: 'active',
        context: {
            kind: 'chat-generation',
            postprocess: { providerBackend: 'http' },
        },
    }

    it('waits for the final journal before persisting provider output and scheduling postprocessing', async () => {
        repository.setGenerationJobClientProjection.mockReturnValue(true)
        let finishProvider!: () => void
        const runPromise = new Promise<void>(resolve => { finishProvider = resolve })
        const { handler, scheduleRevenantPostprocess } = installProjectionRoute(
            { ...pendingJob, status: 'generating', projection: undefined },
            providerWorkflow,
            new Map([['job-1', { runPromise }]]),
        )
        const send = vi.fn()
        const response: any = { send, status: vi.fn(() => response) }

        const completion = handler?.(
            { params: { jobId: 'job-1' }, body: { content: 'final provider text', providerResult: true } },
            response,
        )

        await vi.waitFor(() => expect(repository.getGenerationJob).toHaveBeenCalled())
        expect(repository.setGenerationJobClientProjection).not.toHaveBeenCalled()
        repository.getGenerationJob.mockReturnValue(pendingJob)
        finishProvider()
        await completion

        expect(repository.setGenerationJobClientProjection).toHaveBeenCalledWith('job-1', {
            schemaVersion: 1,
            source: 'provider',
            adapterKind: 'openai-compatible',
            content: 'final provider text',
            journalBytes: 123,
        })
        expect(scheduleRevenantPostprocess).toHaveBeenCalledOnce()
        expect(send).toHaveBeenCalledWith({ success: true })
    })

    it('ignores a final provider result after a normal server projection completed the workflow', async () => {
        const { handler, scheduleRevenantPostprocess } = installProjectionRoute(
            {
                ...pendingJob,
                status: 'generated',
                materializedAt: 1234,
                projection: { ...pendingJob.projection, content: 'server text', awaitingProviderResult: false },
            },
            { ...providerWorkflow, status: 'completed' },
        )
        const send = vi.fn()
        const response: any = { send, status: vi.fn(() => response) }

        await handler?.(
            { params: { jobId: 'job-1' }, body: { content: 'late provider text', providerResult: true } },
            response,
        )

        expect(repository.setGenerationJobClientProjection).not.toHaveBeenCalled()
        expect(scheduleRevenantPostprocess).not.toHaveBeenCalled()
        expect(send).toHaveBeenCalledWith({ success: true, ignored: true })
    })

    it('rejects blank pending results, wrong workflows, and finalized pending workflows', async () => {
        const blank = installProjectionRoute(pendingJob, providerWorkflow)
        const blankStatus = vi.fn()
        const blankResponse: any = {
            send: vi.fn(),
            status: vi.fn((code: number) => { blankStatus(code); return blankResponse }),
        }
        await blank.handler?.(
            { params: { jobId: 'job-1' }, body: { content: '  ', providerResult: true } },
            blankResponse,
        )
        expect(blankStatus).toHaveBeenCalledWith(400)

        const finalized = installProjectionRoute(pendingJob, { ...providerWorkflow, status: 'completed' })
        const finalStatus = vi.fn()
        const finalResponse: any = {
            send: vi.fn(),
            status: vi.fn((code: number) => { finalStatus(code); return finalResponse }),
        }
        await finalized.handler?.(
            { params: { jobId: 'job-1' }, body: { content: 'late text', providerResult: true } },
            finalResponse,
        )
        expect(finalStatus).toHaveBeenCalledWith(409)
        expect(repository.setGenerationJobClientProjection).not.toHaveBeenCalled()

        const wrongWorkflow = installProjectionRoute(pendingJob, {
            ...providerWorkflow,
            context: { kind: 'llm-request', postprocess: { providerBackend: 'http' } },
        })
        const wrongWorkflowStatus = vi.fn()
        const wrongWorkflowResponse: any = {
            send: vi.fn(),
            status: vi.fn((code: number) => {
                wrongWorkflowStatus(code)
                return wrongWorkflowResponse
            }),
        }
        await wrongWorkflow.handler?.(
            { params: { jobId: 'job-1' }, body: { content: 'text', providerResult: true } },
            wrongWorkflowResponse,
        )
        expect(wrongWorkflowStatus).toHaveBeenCalledWith(409)
        expect(repository.setGenerationJobClientProjection).not.toHaveBeenCalled()
    })
})

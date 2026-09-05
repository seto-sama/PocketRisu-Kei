import { afterEach, describe, expect, it, vi } from 'vitest'
import workersPkg from './generationWorkers.cjs'

const { createGenerationWorkers } = workersPkg as {
    createGenerationWorkers: (options: Record<string, unknown>) => {
        scheduleGenerationDispatch: (delayMs?: number) => void
        scheduleHypaWorkflowExecution: (delayMs?: number) => void
    }
}

afterEach(() => {
    vi.useRealTimers()
})

function baseOptions(repository: Record<string, unknown>) {
    return {
        repository: {
            listQueuedGenerationDispatches: () => [],
            listQueuedGenerationWorkflowExecutions: () => [],
            ...repository,
        },
        logger: { error: vi.fn() },
        generationRuntimeJobs: new Map(),
        maxActiveJobs: 4,
        countActiveGenerationJobs: () => 0,
        createGenerationRuntimeJob: vi.fn(),
        runGenerationProviderJob: vi.fn(),
        markGenerationJobDone: vi.fn(),
        sanitizeGenerationTargetUrl: (value: string) => value,
    }
}

describe('generation workers', () => {
    it.each([false, true])('continues server-owned Hypa without browser calls (summary failure=%s)', async failSummary => {
        vi.useFakeTimers()
        const workflow = { workflowId: 'workflow-1', characterId: 'char-1', roomId: 'room-1', status: 'active' }
        const execution: any = { workflowId: workflow.workflowId, kind: 'hypav3-selection', status: 'queued', recipe: {
            embedding: { model: 'voyageContext3' }, batchId: 'batch-1', expectedOperationIds: ['one', 'two'], memory: { summaries: [] },
            summaryProvider: {}, summaryDispatch: { maxConcurrent: 1, requestsPerMinute: 20 },
            summaryRequests: ['one', 'two'].map(operationId => ({ operationId, purpose: 'memory', chatMemos: [operationId], prompt: [] })),
        } }
        const main: any = { jobId: 'main', workflowId: workflow.workflowId, workflowStepKey: 'model.main', status: 'queued' }
        const jobs: any[] = []
        const pending: Array<() => void> = []
        const executeSummaryAction = vi.fn(({ operationContext }: any) => new Promise(resolve => {
            const job: any = { jobId: operationContext.operationId, status: 'generating', operationContext }
            jobs.push(job)
            pending.push(() => {
                job.status = 'generated'
                job.projection = { content: `summary-${job.jobId}` }
                resolve({ success: !(failSummary && job.jobId === 'two'), result: job.projection.content })
            })
        }))
        const requestSpec = {
            workflowDependency: { kind: 'hypav3-selection', placeholder: '__memory__' },
            bodyBase64: Buffer.from(JSON.stringify({ messages: [{ content: '__memory__' }] })).toString('base64'),
        }
        const runGenerationProviderJob = vi.fn(async () => { main.status = 'generated' })
        const selectMemory = vi.fn(async (_recipe, summaries) => ({
            memory: { summaries }, currentTokens: 100,
            chatSequence: [{ chat: { memo: 'supaMemory', content: summaries.map((summary: any) => summary.text).join('\n') } }],
        }))
        const workers = createGenerationWorkers({
            ...baseOptions({
                finishGenerationJob: (_id: string, status: string) => { main.status = status },
                getGenerationWorkflow: () => workflow,
                listQueuedGenerationWorkflowExecutions: () => execution.status === 'queued' ? [execution] : [],
                listGenerationWorkflowJobs: () => jobs,
                getGenerationWorkflowExecution: () => execution,
                claimGenerationWorkflowExecution: () => { execution.status = 'running'; return execution },
                finishGenerationWorkflowExecution: (_id: string, status: string, result: any) => Object.assign(execution, { status, result }),
                updateGenerationWorkflowStep: vi.fn(),
                listQueuedGenerationDispatches: () => main.status === 'queued'
                    ? [{ job: main, requestSpec, dispatchGroup: 'main', maxConcurrent: 1, requestsPerMinute: 1000 }] : [],
                getGenerationDispatchState: () => ({ active: 0, recent: 0 }),
                claimQueuedGenerationDispatch: () => ({ job: main, requestSpec }),
            }),
            executeSummaryAction, selectMemory, runGenerationProviderJob,
            createGenerationRuntimeJob: () => ({}),
        })
        workers.scheduleHypaWorkflowExecution()
        await vi.advanceTimersByTimeAsync(1)
        expect(executeSummaryAction).not.toHaveBeenCalled()
        jobs.push(main)
        workers.scheduleGenerationDispatch()
        workers.scheduleHypaWorkflowExecution()
        await vi.advanceTimersByTimeAsync(1)
        expect(executeSummaryAction).toHaveBeenCalledTimes(2)
        expect(runGenerationProviderJob).not.toHaveBeenCalled()
        workers.scheduleHypaWorkflowExecution()
        await vi.advanceTimersByTimeAsync(1)
        expect(executeSummaryAction).toHaveBeenCalledTimes(2)
        pending[0]()
        await vi.advanceTimersByTimeAsync(1)
        expect(runGenerationProviderJob).not.toHaveBeenCalled()
        pending[1]()
        await vi.advanceTimersByTimeAsync(10)
        if (failSummary) {
            expect(selectMemory).not.toHaveBeenCalled()
            expect(runGenerationProviderJob).not.toHaveBeenCalled()
            expect(main.status).toBe('failed')
            return
        }
        expect(selectMemory).toHaveBeenCalledTimes(1)
        expect(runGenerationProviderJob).toHaveBeenCalledTimes(1)
        const body = JSON.parse(Buffer.from(runGenerationProviderJob.mock.calls[0][1].bodyBase64, 'base64').toString())
        expect(body.messages[0].content).toBe('summary-one\nsummary-two')
    })

    it('preserves a rate-limit wake delay instead of immediately polling again', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const listQueuedGenerationDispatches = vi.fn(() => [{
            job: { jobId: 'job-1' },
            requestSpec: {},
            dispatchGroup: 'provider/model',
            maxConcurrent: 1,
            requestsPerMinute: 1,
        }])
        const workers = createGenerationWorkers(baseOptions({
            listQueuedGenerationDispatches,
            getGenerationDispatchState: () => ({
                active: 0,
                recent: 1,
                oldestRecent: 100_000,
            }),
        }))

        workers.scheduleGenerationDispatch()
        await vi.advanceTimersByTimeAsync(0)
        expect(listQueuedGenerationDispatches).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(59_999)
        expect(listQueuedGenerationDispatches).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(1)
        expect(listQueuedGenerationDispatches).toHaveBeenCalledTimes(2)
    })

    it('aborts server-side embedding selection at the configured generation timeout', async () => {
        vi.useFakeTimers()
        const finishGenerationWorkflowExecution = vi.fn()
        const selectMemory = vi.fn((
            _recipe: unknown,
            _summaries: unknown,
            deps: { signal: AbortSignal },
        ) =>
            new Promise((_resolve, reject) => {
                deps.signal.addEventListener('abort', () => reject(deps.signal.reason), { once: true })
            }))
        const workers = createGenerationWorkers({
            ...baseOptions({
                listQueuedGenerationWorkflowExecutions: () => [{
                    workflowId: 'workflow-1',
                    recipe: {
                        expectedOperationIds: [],
                        memory: { summaries: [] },
                        embedding: { model: 'openai3large' },
                    },
                }],
                listGenerationWorkflowJobs: () => [],
                claimGenerationWorkflowExecution: () => true,
                finishGenerationWorkflowExecution,
                updateGenerationWorkflowStep: vi.fn(),
            }),
            embeddingTimeoutMs: 100,
            selectMemory,
        })

        workers.scheduleHypaWorkflowExecution()
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(100)

        expect(selectMemory).toHaveBeenCalledOnce()
        expect(finishGenerationWorkflowExecution).toHaveBeenCalledWith(
            'workflow-1',
            'failed',
            null,
            'HypaV3 embedding timed out',
        )
    })
})

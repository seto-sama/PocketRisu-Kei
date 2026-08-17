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

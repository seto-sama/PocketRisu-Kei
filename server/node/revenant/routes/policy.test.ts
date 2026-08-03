import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
    UNREGISTERED_WORKFLOW_TIMEOUT_MS,
    findReusableActiveMainJob,
    hasRegisteredMainJob,
    isUnregisteredWorkflowExpired,
} = require('./policy.cjs') as {
    UNREGISTERED_WORKFLOW_TIMEOUT_MS: number
    findReusableActiveMainJob: (
        jobs: Array<Record<string, unknown>>,
        request: Record<string, unknown>,
    ) => Record<string, unknown> | undefined
    hasRegisteredMainJob: (jobs: Array<Record<string, unknown>>) => boolean
    isUnregisteredWorkflowExpired: (
        workflow: { createdAt: number },
        jobs: Array<Record<string, unknown>>,
        now?: number,
    ) => boolean
}

describe('generation route main-job race recovery', () => {
    const request = {
        jobType: 'model',
        workflowId: 'workflow-1',
        workflowStepKey: 'model.main',
        characterId: 'character-1',
        roomId: 'room-1',
    }

    it('reattaches a second workflow observer to the active main job', () => {
        const job = {
            jobId: 'job-1',
            ...request,
            status: 'generating',
        }

        expect(findReusableActiveMainJob([job], request)).toBe(job)
    })

    it('does not reuse a job from another workflow or a terminal job', () => {
        expect(findReusableActiveMainJob([
            { jobId: 'other', ...request, workflowId: 'workflow-2', status: 'generating' },
            { jobId: 'done', ...request, status: 'generated' },
        ], request)).toBeUndefined()
    })

    it('keeps a workflow private until its main job is registered', () => {
        const createdAt = 10_000
        expect(hasRegisteredMainJob([])).toBe(false)
        expect(isUnregisteredWorkflowExpired(
            { createdAt },
            [],
            createdAt + UNREGISTERED_WORKFLOW_TIMEOUT_MS - 1,
        )).toBe(false)
        expect(isUnregisteredWorkflowExpired(
            { createdAt },
            [],
            createdAt + UNREGISTERED_WORKFLOW_TIMEOUT_MS,
        )).toBe(true)

        const registered = [{ jobType: 'model' }]
        expect(hasRegisteredMainJob(registered)).toBe(true)
        expect(isUnregisteredWorkflowExpired(
            { createdAt },
            registered,
            createdAt + UNREGISTERED_WORKFLOW_TIMEOUT_MS,
        )).toBe(false)
    })
})

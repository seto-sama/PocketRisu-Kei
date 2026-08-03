import { describe, expect, it, vi } from 'vitest'
import workerPkg from './postprocessWorker.cjs'

const { createRevenantPostprocessWorker } = workerPkg as {
    createRevenantPostprocessWorker: (options: any) => { pump: () => Promise<void> }
}

describe('revenant postprocess worker', () => {
    it('claims and transforms terminal model output exactly once', async () => {
        let status = 'pending'
        const metadata: any[] = []
        const repository = {
            listReadyChatWorkflowJobs: () => [{
                jobId: 'job-1', workflowId: 'workflow-1', projection: { content: ' result ' },
                isContinuation: true, continuationPrefix: 'prefix:',
            }],
            getGenerationWorkflow: () => ({
                workflowId: 'workflow-1',
                context: { kind: 'chat-generation', postprocess: { schemaVersion: 1 } },
                steps: [{ key: 'output.transform', status }],
            }),
            claimGenerationWorkflowStep: () => {
                if (status !== 'pending') return null
                status = 'running'
                return {}
            },
            updateGenerationWorkflowStep: (_workflowId: string, _step: string, update: any) => {
                status = update.status
                metadata.push(update.metadata)
            },
        }
        const transformOutput = vi.fn(() => ({
            text: 'processed', chat: { id: 'room-1', message: [] }, foregroundEffects: [], errors: [],
        }))
        const worker = createRevenantPostprocessWorker({ repository, transformOutput, logger: { error: vi.fn() } })

        await worker.pump()
        await worker.pump()

        expect(transformOutput).toHaveBeenCalledOnce()
        expect(transformOutput).toHaveBeenCalledWith('prefix: result', { schemaVersion: 1 })
        expect(metadata).toEqual([{
            schemaVersion: 1,
            text: 'processed',
            chat: { id: 'room-1', message: [] },
            foregroundEffects: [],
            errors: [],
        }])
    })
})

import { describe, expect, it, vi } from 'vitest'
import workerPkg from './postprocessWorker.cjs'

const { createRevenantPostprocessWorker } = workerPkg as {
    createRevenantPostprocessWorker: (options: any) => { pump: () => Promise<void> }
}

describe('revenant postprocess worker', () => {
    it('claims and transforms terminal model output exactly once', async () => {
        const steps: Record<string, { status: string, metadata?: any }> = {
            'output.transform': { status: 'pending' },
            'trigger.output': { status: 'pending' },
        }
        const updates: Array<{ step: string, update: any }> = []
        const repository = {
            listReadyChatWorkflowJobs: () => [{
                jobId: 'job-1', workflowId: 'workflow-1', projection: { content: ' result ' },
                isContinuation: true, continuationPrefix: 'prefix:',
            }],
            getGenerationWorkflow: () => ({
                workflowId: 'workflow-1',
                context: { kind: 'chat-generation', postprocess: { schemaVersion: 1 } },
                steps: Object.entries(steps).map(([key, step]) => ({ key, ...step })),
            }),
            claimGenerationWorkflowStep: (_workflowId: string, stepKey: string) => {
                if (steps[stepKey].status !== 'pending') return null
                steps[stepKey].status = 'running'
                return {}
            },
            updateGenerationWorkflowStep: (_workflowId: string, stepKey: string, update: any) => {
                steps[stepKey] = { status: update.status, metadata: update.metadata }
                updates.push({ step: stepKey, update })
            },
        }
        const transformOutput = vi.fn(() => ({
            text: 'processed', chat: { id: 'room-1', message: [] }, foregroundEffects: [], errors: [],
        }))
        const runOutputStage = vi.fn(async (options: any) => ({
            status: 'completed',
            ...transformOutput(options.text, options.recipe),
        }))
        const runTriggerStage = vi.fn(async (options: any) => ({
            status: 'completed', chat: options.chat, resend: false, foregroundEffects: [], errors: [],
        }))
        const worker = createRevenantPostprocessWorker({
            repository, transformOutput, runOutputStage, runTriggerStage, logger: { error: vi.fn() },
        })

        await worker.pump()
        await worker.pump()

        expect(transformOutput).toHaveBeenCalledOnce()
        expect(transformOutput).toHaveBeenCalledWith('prefix: result', { schemaVersion: 1 })
        expect(updates.map(update => update.step)).toEqual(['output.transform', 'trigger.output'])
        expect(steps['output.transform'].metadata).toEqual({
            schemaVersion: 1, status: 'completed', text: 'processed',
            chat: { id: 'room-1', message: [] }, foregroundEffects: [], errors: [],
        })
        expect(runTriggerStage).toHaveBeenCalledOnce()
    })
})

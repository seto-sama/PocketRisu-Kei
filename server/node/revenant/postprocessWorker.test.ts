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
            'igp': { status: 'pending' },
            'postprocess': { status: 'pending' },
            'message.materialize': { status: 'pending' },
        }
        const updates: Array<{ step: string, update: any }> = []
        const repository = {
            listReadyChatWorkflowJobs: () => [{
                jobId: 'job-1', workflowId: 'workflow-1', projection: { content: ' result ' },
                isContinuation: true, continuationPrefix: 'prefix:',
            }],
            getGenerationWorkflow: () => ({
                workflowId: 'workflow-1',
                context: {
                    kind: 'chat-generation',
                    postprocess: { schemaVersion: 1, database: { igpPrompt: '' } },
                },
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
            finishGenerationWorkflow: vi.fn(),
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
            repository, transformOutput, runOutputStage, runTriggerStage,
            materializeGeneration: vi.fn(), logger: { error: vi.fn() },
        })

        await worker.pump()
        await worker.pump()

        expect(transformOutput).toHaveBeenCalledOnce()
        expect(transformOutput).toHaveBeenCalledWith(
            'prefix: result',
            expect.objectContaining({ schemaVersion: 1 }),
        )
        expect(updates.map(update => update.step)).toEqual([
            'output.transform', 'trigger.output', 'igp', 'postprocess',
        ])
        expect(steps['output.transform'].metadata).toEqual({
            schemaVersion: 1, status: 'completed', text: 'processed',
            chat: { id: 'room-1', message: [] }, foregroundEffects: [], errors: [],
        })
        expect(runTriggerStage).toHaveBeenCalledOnce()
        expect(repository.finishGenerationWorkflow).toHaveBeenCalledOnce()
        expect(repository.finishGenerationWorkflow).toHaveBeenCalledWith('workflow-1', 'completed')
    })

    it('fails the workflow only when a server-owned transform throws', async () => {
        const steps: Record<string, { status: string, metadata?: any }> = {
            'output.transform': { status: 'pending' },
        }
        const repository = {
            listReadyChatWorkflowJobs: () => [{
                jobId: 'job-1', workflowId: 'workflow-1', projection: { content: 'result' },
            }],
            getGenerationWorkflow: () => ({
                workflowId: 'workflow-1',
                context: { kind: 'chat-generation', postprocess: {} },
                steps: Object.entries(steps).map(([key, step]) => ({ key, ...step })),
            }),
            claimGenerationWorkflowStep: (_workflowId: string, stepKey: string) => {
                if (steps[stepKey].status !== 'pending') return null
                steps[stepKey].status = 'running'
                return {}
            },
            updateGenerationWorkflowStep: (_workflowId: string, stepKey: string, update: any) => {
                steps[stepKey] = { status: update.status, metadata: update.metadata }
            },
            finishGenerationWorkflow: vi.fn(),
        }
        const worker = createRevenantPostprocessWorker({
            repository,
            runOutputStage: vi.fn(async () => { throw new Error('transform failed') }),
            logger: { error: vi.fn() },
        })

        await worker.pump()

        expect(steps['output.transform']).toEqual({
            status: 'failed',
            metadata: { schemaVersion: 1, error: 'transform failed' },
        })
        expect(repository.finishGenerationWorkflow).toHaveBeenCalledOnce()
        expect(repository.finishGenerationWorkflow).toHaveBeenCalledWith('workflow-1', 'failed')
    })

    it('fails instead of silently materializing a trigger execution error', async () => {
        const chat = { id: 'room-1', message: [{ role: 'char', data: 'answer' }] }
        const steps: Record<string, { status: string, metadata?: any }> = {
            'output.transform': { status: 'completed', metadata: { text: 'answer', chat } },
            'trigger.output': { status: 'pending' },
        }
        const repository = {
            listReadyChatWorkflowJobs: () => [{ jobId: 'job-1', workflowId: 'workflow-1' }],
            getGenerationWorkflow: () => ({
                workflowId: 'workflow-1',
                context: { kind: 'chat-generation', postprocess: {} },
                steps: Object.entries(steps).map(([key, step]) => ({ key, ...step })),
            }),
            claimGenerationWorkflowStep: (_workflowId: string, stepKey: string) => {
                if (steps[stepKey].status !== 'pending') return null
                steps[stepKey].status = 'running'
                return {}
            },
            updateGenerationWorkflowStep: (_workflowId: string, stepKey: string, update: any) => {
                steps[stepKey] = { status: update.status, metadata: update.metadata }
            },
            finishGenerationWorkflow: vi.fn(),
        }
        const worker = createRevenantPostprocessWorker({
            repository,
            runTriggerStage: vi.fn(async () => ({
                status: 'completed', chat, foregroundEffects: [],
                errors: ['invalid trigger regex'],
            })),
            logger: { error: vi.fn() },
        })

        await worker.pump()

        expect(steps['trigger.output']).toEqual({
            status: 'failed',
            metadata: { schemaVersion: 1, error: 'invalid trigger regex' },
        })
        expect(repository.finishGenerationWorkflow).toHaveBeenCalledWith('workflow-1', 'failed')
    })

    it('renders IGP against the completed chat and uses its auxiliary preset', async () => {
        const chat = { id: 'room-1', message: [{ role: 'char', data: 'answer' }] }
        const steps: Record<string, { status: string, metadata?: any }> = {
            'output.transform': { status: 'completed', metadata: { text: 'answer', chat } },
            'trigger.output': {
                status: 'completed',
                metadata: { chat, foregroundEffects: [] },
            },
            'igp': { status: 'pending' },
            'postprocess': { status: 'pending' },
            'message.materialize': { status: 'pending' },
        }
        const repository = {
            listReadyChatWorkflowJobs: () => [{ jobId: 'job-1', workflowId: 'workflow-1' }],
            getGenerationWorkflow: () => ({
                workflowId: 'workflow-1',
                context: {
                    kind: 'chat-generation',
                    postprocess: {
                        database: { igpPrompt: 'raw {{char}}' },
                        auxProviders: {
                            emotion: {
                                backend: 'plugin',
                                modelPreset: { id: 'aux-preset' },
                            },
                        },
                    },
                },
                steps: Object.entries(steps).map(([key, step]) => ({ key, ...step })),
            }),
            claimGenerationWorkflowStep: (_workflowId: string, stepKey: string) => {
                if (steps[stepKey].status !== 'pending') return null
                steps[stepKey].status = 'running'
                return {}
            },
            updateGenerationWorkflowStep: (_workflowId: string, stepKey: string, update: any) => {
                steps[stepKey] = { status: update.status, metadata: update.metadata }
            },
            finishGenerationWorkflow: vi.fn(),
        }
        const renderPrompt = vi.fn(() => 'rendered prompt')
        const worker = createRevenantPostprocessWorker({
            repository,
            renderPrompt,
            logger: { error: vi.fn() },
        })

        await worker.pump()

        expect(renderPrompt).toHaveBeenCalledWith(
            'raw {{char}}',
            expect.objectContaining({ auxProviders: expect.any(Object) }),
            chat,
        )
        expect(steps.igp).toMatchObject({
            status: 'waiting_client',
            metadata: {
                action: {
                    kind: 'provider.igp',
                    payload: {
                        backend: 'plugin',
                        modelPreset: { id: 'aux-preset' },
                        prompt: 'rendered prompt',
                    },
                },
            },
        })
    })

    it('waits for a client to run completion UI effects before materializing', async () => {
        const chat = { id: 'room-1', message: [{ role: 'char', data: 'final answer' }] }
        const steps: Record<string, { status: string, metadata?: any }> = {
            'output.transform': {
                status: 'completed',
                metadata: { text: 'final answer', chat, foregroundEffects: [] },
            },
            'trigger.output': {
                status: 'completed',
                metadata: { chat, resend: true, foregroundEffects: [] },
            },
            'igp': { status: 'skipped', metadata: { chat } },
            'postprocess': { status: 'pending' },
            'message.materialize': { status: 'pending' },
        }
        const repository = {
            listReadyChatWorkflowJobs: () => [{ jobId: 'job-1', workflowId: 'workflow-1' }],
            getGenerationWorkflow: () => ({
                workflowId: 'workflow-1',
                context: {
                    kind: 'chat-generation',
                    postprocess: {
                        character: {
                            viewScreen: 'emotion', inlayViewScreen: false,
                            emotionImages: [['happy', 'asset']],
                        },
                        database: {
                            igpPrompt: '', notification: true,
                            ttsEnabled: true, ttsAutoSpeech: true,
                            emotionProcesser: 'embedding', emotionPrompt2: '',
                        },
                    },
                },
                steps: Object.entries(steps).map(([key, step]) => ({ key, ...step })),
            }),
            claimGenerationWorkflowStep: (_workflowId: string, stepKey: string) => {
                if (steps[stepKey].status !== 'pending') return null
                steps[stepKey].status = 'running'
                return {}
            },
            updateGenerationWorkflowStep: (_workflowId: string, stepKey: string, update: any) => {
                steps[stepKey] = { status: update.status, metadata: update.metadata }
            },
            finishGenerationWorkflow: vi.fn(),
        }
        const materializeGeneration = vi.fn()
        const worker = createRevenantPostprocessWorker({
            repository, materializeGeneration, logger: { error: vi.fn() },
        })

        await worker.pump()

        expect(steps.postprocess).toMatchObject({
            status: 'waiting_client',
            metadata: {
                chat,
                action: {
                    kind: 'ui.effects',
                    payload: {
                        chat,
                        effects: [
                            {
                                kind: 'emotion.auto', text: 'final answer',
                                processor: 'embedding', prompt: '',
                            },
                            { kind: 'notification', text: 'final answer' },
                            { kind: 'tts', text: 'final answer' },
                            { kind: 'chat.resend' },
                        ],
                    },
                },
            },
        })
        expect(materializeGeneration).not.toHaveBeenCalled()
        expect(repository.finishGenerationWorkflow).not.toHaveBeenCalled()

        const inlayChat = {
            ...chat,
            message: [{ role: 'char', data: 'final answer {{inlay::asset-id}}' }],
        }
        steps.postprocess = {
            status: 'pending',
            metadata: {
                responses: {
                    'postprocess.ui-effects': { chat: inlayChat },
                },
            },
        }
        await worker.pump()

        expect(steps.postprocess).toMatchObject({
            status: 'completed',
            metadata: { chat: inlayChat },
        })
        expect(materializeGeneration).toHaveBeenCalledWith('job-1')
        expect(repository.finishGenerationWorkflow).toHaveBeenCalledWith('workflow-1', 'completed')
    })
})

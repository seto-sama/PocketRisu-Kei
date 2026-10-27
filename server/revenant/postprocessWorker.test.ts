import { describe, expect, it, vi } from 'vitest'
import workerPkg from './postprocessWorker.cjs'
import materializerPkg from './materializer.cjs'
import chatStorePkg from '../chatStore.cjs'

const { createRevenantMaterializer } = materializerPkg as any
const { createCanonicalChatService, computeChatEtag } = chatStorePkg as any

const { createRevenantPostprocessWorker } = workerPkg as {
    createRevenantPostprocessWorker: (options: any) => { pump: () => Promise<void> }
}

const workflowInputChat = { id: 'room-1', message: [] }

function workflowContext(postprocess: any = {}) {
    return {
        kind: 'chat-generation',
        postprocess: {
            ...postprocess,
            character: { chaId: 'character-1', ...postprocess.character },
            database: { ...postprocess.database },
            chatPatch: postprocess.chatPatch ?? [],
        },
    }
}

type Steps = Record<string, { status: string, metadata?: any }>

// In-memory workflow repository for a single job whose steps live in `steps`.
function createRepository(steps: Steps, {
    workflowId = 'workflow-1',
    context = workflowContext(),
    job = { jobId: 'job-1', workflowId } as any,
} = {}) {
    const listSteps = () => Object.entries(steps).map(([key, step]) => ({ key, ...step }))
    return {
        listReadyChatWorkflowJobs: () => [job],
        getGenerationWorkflow: () => ({ workflowId, status: 'active', context, steps: listSteps() }),
        getGenerationWorkflowInputChat: () => workflowInputChat,
        claimGenerationWorkflowStep: (_workflowId: string, stepKey: string) => {
            if (steps[stepKey].status !== 'pending') return null
            steps[stepKey].status = 'running'
            return { steps: listSteps() }
        },
        updateGenerationWorkflowStep: vi.fn((_workflowId: string, stepKey: string, update: any) => {
            steps[stepKey] = { status: update.status, metadata: update.metadata }
        }),
        finishGenerationWorkflow: vi.fn(),
    }
}

describe('revenant postprocess worker', () => {
    it.each([{ choices: ['local'] }, { choices: null }])('settles a real materialization conflict after the client responds: %j', async ({ choices }) => {
        const input = { ...workflowInputChat, scriptstate: { $score: '10' } }
        const current = { ...input, scriptstate: { $score: '20' } }
        const chat = { ...input, scriptstate: { $score: '13' }, message: [{ role: 'char', data: 'answer', chatId: 'generated-1' }] }
        const chats = new Map([['room-1', current]])
        const job = {
            jobId: 'job-1', workflowId: 'workflow-1', characterId: 'character-1',
            roomId: 'room-1', chatId: 'generated-1', status: 'generated', createdAt: 1,
        }
        const steps: Record<string, { status: string, metadata?: any }> = {
            'output.transform': { status: 'completed', metadata: { text: 'answer', chat, foregroundEffects: [] } },
            'trigger.output': { status: 'completed', metadata: { chat, foregroundEffects: [] } },
            'postprocess': { status: 'completed', metadata: { chat } },
            'message.materialize': { status: 'pending' },
        }
        let status = 'active'
        const repository = {
            listReadyChatWorkflowJobs: () => status === 'active' ? [job] : [],
            getGenerationJob: () => job,
            getGenerationWorkflow: () => ({
                workflowId: 'workflow-1', status, context: workflowContext({ messageChatId: job.chatId }),
                steps: Object.entries(steps).map(([key, step]) => ({ key, ...step })),
            }),
            getGenerationWorkflowInputChat: () => input,
            getEarlierRecoverableGenerationWorkflowJob: () => undefined,
            markGenerationMaterialized: () => { steps['message.materialize'].status = 'completed'; return true },
            claimGenerationWorkflowStep: (_id: string, key: string) => {
                if (steps[key].status !== 'pending') return null
                steps[key].status = 'running'
                return { steps: Object.entries(steps).map(([key, step]) => ({ key, ...step })) }
            },
            updateGenerationWorkflowStep: (_id: string, key: string, update: any) => { steps[key] = update },
            finishGenerationWorkflow: vi.fn((_id: string, terminal: string) => { status = terminal }),
        }
        const persistChat = vi.fn(async ({ chatId, chat }: any) => {
            chats.set(chatId, chat)
            return { chat, etag: computeChatEtag(chat) }
        })
        const canonicalChatService = createCanonicalChatService({
            queueStorageOperation: (operation: () => Promise<any>) => operation(),
            loadChat: async () => {
                const chat = chats.get('room-1')
                return { chat: structuredClone(chat), etag: computeChatEtag(chat) }
            },
            getGenerationWorkflowInputChat: () => input,
            persistChat, publishChatCommitted: vi.fn(),
        })
        const materializer = createRevenantMaterializer({ repository, canonicalChatService })
        const materializeGeneration = vi.fn(materializer.materialize)
        const onWorkflowUpdated = vi.fn()
        const worker = createRevenantPostprocessWorker({
            repository, materializeGeneration, onWorkflowUpdated, logger: { error: vi.fn() },
        })

        await worker.pump()
        expect(steps['message.materialize'].status).toBe('waiting_client')
        const action = steps['message.materialize'].metadata.action
        expect(action.kind).toBe('ui.resolve-conflict')
        expect(persistChat).not.toHaveBeenCalled()
        await worker.pump()
        expect(materializeGeneration).toHaveBeenCalledOnce()
        expect(repository.finishGenerationWorkflow).not.toHaveBeenCalled()

        steps['message.materialize'] = { status: 'pending', metadata: { responses: { [action.actionId]: choices } } }
        await worker.pump()
        const terminal = choices === null ? 'failed' : 'completed'
        expect(status).toBe(terminal)
        expect(onWorkflowUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ status: terminal }))
        expect(chats.get('room-1')).toMatchObject(choices === null ? current : chat)
        expect(persistChat).toHaveBeenCalledTimes(choices === null ? 0 : 1)
    })

    it('executes image actions on the server without exposing waiting_client', async () => {
        const steps: Steps = { 'output.transform': { status: 'pending', metadata: {} } }
        const repository = createRepository(steps, {
            workflowId: 'workflow-image',
            job: { jobId: 'job-1', workflowId: 'workflow-image', projection: { content: 'result' } },
        })
        const action = {
            actionId: 'script.image', kind: 'image.generate',
            payload: { prompt: 'portrait', negativePrompt: '' },
        }
        const runOutputStage = vi.fn(async ({ responses }: any) => {
            if (!responses?.[action.actionId]) return { status: 'waiting_client', action }
            return {
                status: 'completed', text: responses[action.actionId],
                chat: { id: 'room-1', message: [] }, foregroundEffects: [], errors: [],
            }
        })
        const executeImageAction = vi.fn(async () => ({ reference: '{{inlayed::server-image}}' }))
        const worker = createRevenantPostprocessWorker({
            repository,
            runOutputStage,
            executeImageAction,
            logger: { error: vi.fn() },
        })

        await worker.pump()

        expect(executeImageAction).toHaveBeenCalledWith(expect.objectContaining({
            workflow: expect.objectContaining({ workflowId: 'workflow-image' }),
            action,
        }))
        expect(steps['output.transform'].status).not.toBe('waiting_client')
        await vi.waitFor(() => expect(steps['output.transform'].metadata?.responses).toEqual({
            'script.image': '{{inlayed::server-image}}',
        }))
    })

    it('claims and transforms terminal model output once', async () => {
        const steps: Steps = {
            'output.transform': { status: 'pending' },
            'trigger.output': { status: 'pending' },
            'postprocess': { status: 'pending' },
            'message.materialize': { status: 'pending' },
        }
        const repository = createRepository(steps, {
            context: workflowContext({ schemaVersion: 1 }),
            job: { jobId: 'job-1', workflowId: 'workflow-1', projection: { content: ' result ' } },
        })
        const transformOutput = vi.fn(() => ({
            text: 'processed', chat: { id: 'room-1', message: [] }, foregroundEffects: [], errors: [],
        }))
        // Uses the transform the worker hands over, so dropping it fails the test.
        const runOutputStage = vi.fn(async (options: any) => ({
            status: 'completed',
            ...options.transformOutput(options.text, options.recipe),
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
            'result',
            expect.objectContaining({ schemaVersion: 1 }),
        )
        expect(repository.updateGenerationWorkflowStep.mock.calls.map(call => call[1])).toEqual([
            'output.transform', 'trigger.output', 'postprocess',
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
        const steps: Steps = { 'output.transform': { status: 'pending' } }
        const repository = createRepository(steps, {
            job: { jobId: 'job-1', workflowId: 'workflow-1', projection: { content: 'result' } },
        })
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
        const steps: Steps = {
            'output.transform': { status: 'completed', metadata: { text: 'answer', chat } },
            'trigger.output': { status: 'pending' },
        }
        const repository = createRepository(steps)
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

    it('waits for a client to run completion UI effects before materializing', async () => {
        const chat = { id: 'room-1', message: [{ role: 'char', data: 'final answer' }] }
        const steps: Steps = {
            'output.transform': {
                status: 'completed',
                metadata: { text: 'final answer', chat, foregroundEffects: [] },
            },
            'trigger.output': {
                status: 'completed',
                metadata: { chat, resend: true, foregroundEffects: [] },
            },
            'postprocess': { status: 'pending' },
            'message.materialize': { status: 'pending' },
        }
        const repository = createRepository(steps, {
            context: workflowContext({
                database: {
                    notification: true,
                    ttsEnabled: true, ttsAutoSpeech: true,
                },
            }),
        })
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

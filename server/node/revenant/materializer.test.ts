// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import materializerPkg from './materializer.cjs'
import chatStorePkg from '../chatStore.cjs'

const { computeChatEtag } = chatStorePkg as any

const { createRevenantMaterializer } = materializerPkg as {
    createRevenantMaterializer: (options: any) => {
        materialize: (jobId: string, input?: any) => Promise<any>
        materializeCancellation: (workflowId: string) => Promise<any>
    }
}

describe('revenant canonical materializer', () => {
    it('materializes earlier cancellations in order before a newer response', async () => {
        const inputChat = {
            id: 'room-1',
            message: [{ role: 'user', data: 'hello', chatId: 'user-1' }],
        }
        const newerChat = {
            ...inputChat,
            message: [
                ...inputChat.message,
                { role: 'char', data: 'try again later', chatId: 'message-3' },
            ],
        }
        const jobs = new Map<string, any>([
            ['standalone-job', {
                jobId: 'standalone-job', jobType: 'model',
                characterId: 'character-1', roomId: 'room-1', chatId: 'standalone-message',
                status: 'generated', createdAt: 0,
            }],
            ['job-1', {
                jobId: 'job-1', workflowId: 'workflow-1', jobType: 'model',
                characterId: 'character-1', roomId: 'room-1', chatId: 'message-1',
                status: 'cancelled', createdAt: 1,
            }],
            ['job-2', {
                jobId: 'job-2', workflowId: 'workflow-2', jobType: 'model',
                characterId: 'character-1', roomId: 'room-1', chatId: 'message-2',
                status: 'cancelled', createdAt: 2,
            }],
            ['job-3', {
                jobId: 'job-3', workflowId: 'workflow-3', jobType: 'model',
                characterId: 'character-1', roomId: 'room-1', chatId: 'message-3',
                status: 'generated', createdAt: 3,
            }],
        ])
        const workflows = new Map([
            ['workflow-1', {
                workflowId: 'workflow-1', status: 'cancelled',
                context: {
                    inputCommit: { chat: inputChat },
                    postprocess: { chat: inputChat, messageChatId: 'message-1' },
                },
                steps: [],
            }],
            ['workflow-2', {
                workflowId: 'workflow-2', status: 'cancelled',
                context: {
                    inputCommit: { chat: inputChat },
                    postprocess: { chat: inputChat, messageChatId: 'message-2' },
                },
                steps: [],
            }],
            ['workflow-3', {
                workflowId: 'workflow-3', status: 'active',
                context: {
                    inputCommit: { chat: inputChat },
                    postprocess: { chat: inputChat, messageChatId: 'message-3' },
                },
                steps: [{
                    key: 'postprocess', status: 'completed', metadata: { chat: newerChat },
                }],
            }],
        ])
        const materializationOrder: string[] = []
        const repository = {
            getGenerationJob: (jobId: string) => jobs.get(jobId),
            getGenerationWorkflow: (workflowId: string) => workflows.get(workflowId),
            listGenerationWorkflowJobs: (workflowId: string) =>
                [...jobs.values()].filter(job => job.workflowId === workflowId),
            getEarlierRecoverableGenerationWorkflowJob: (
                characterId: string,
                roomId: string,
                createdAt: number,
            ) => [...jobs.values()]
                .filter(job =>
                    job.workflowId
                    && job.characterId === characterId
                    && job.roomId === roomId
                    && job.createdAt < createdAt
                    && !job.materializedAt)
                .sort((left, right) => left.createdAt - right.createdAt)[0],
            markGenerationMaterialized: (jobId: string) => {
                const job = jobs.get(jobId)
                if (!job) return false
                job.materializedAt = Date.now()
                materializationOrder.push(jobId)
                return true
            },
            readGenerationJobRaw: () => Buffer.alloc(0),
            updateGenerationWorkflowStep: vi.fn(),
        }
        const service = createRevenantMaterializer({
            repository,
            canonicalChatService: {
                commitGenerationResult: vi.fn(async (input: any) => {
                    await input.finalize()
                    return { chat: input.chat }
                }),
            },
        })

        await service.materialize('job-3')

        expect(materializationOrder).toEqual(['job-1', 'job-2', 'job-3'])
        expect(jobs.get('standalone-job').materializedAt).toBeUndefined()
    })

    it('persists the completed server trigger chat without a client message body', async () => {
        const stored = {
            id: 'room-1',
            message: [{ role: 'user', data: 'hello', chatId: 'user-1' }],
        }
        const canonical = {
            id: 'room-1',
            message: [
                { role: 'user', data: 'hello', chatId: 'user-1' },
                { role: 'char', data: 'server result', chatId: 'message-1' },
            ],
        }
        let materialized = false
        const repository = {
            getGenerationJob: () => ({
                jobId: 'job-1', workflowId: 'workflow-1', characterId: 'character-1',
                roomId: 'room-1', chatId: 'message-1', status: 'generated', createdAt: 1,
            }),
            getGenerationWorkflow: () => ({
                workflowId: 'workflow-1',
                context: {
                    inputCommit: { chat: stored },
                    postprocess: { messageChatId: 'message-1', isContinuation: false },
                },
                steps: [{
                    key: 'postprocess',
                    status: 'completed',
                    metadata: {
                        chat: canonical,
                        mutations: {
                            character: { desc: 'server description' },
                            database: { personaPrompt: 'server persona' },
                        },
                    },
                }],
            }),
            getEarlierRecoverableGenerationWorkflowJob: () => undefined,
            markGenerationMaterialized: () => { materialized = true; return true },
            updateGenerationWorkflowStep: vi.fn(),
        }
        const commitGenerationResult = vi.fn(async (input: any) => {
            await input.finalize()
            return { chat: input.chat }
        })
        const service = createRevenantMaterializer({
            repository,
            canonicalChatService: { commitGenerationResult },
        })

        const result = await service.materialize('job-1')

        expect(result.message).toMatchObject({ data: 'server result', chatId: 'message-1' })
        expect(commitGenerationResult).toHaveBeenCalledWith(expect.objectContaining({
            job: expect.objectContaining({ jobId: 'job-1' }),
            workflow: expect.objectContaining({ workflowId: 'workflow-1' }),
            chat: { ...canonical, isStreaming: false },
            mutationPatch: {
                character: { desc: 'server description' },
                database: { personaPrompt: 'server persona' },
            },
        }))
        expect(repository.updateGenerationWorkflowStep).toHaveBeenCalledWith(
            'workflow-1',
            'message.materialize',
            {
                status: 'running',
                metadata: { schemaVersion: 1, chat: expect.any(Object) },
            },
        )
        expect(materialized).toBe(true)
    })

    it('rejects a stale materializer through the shared chat commit boundary', async () => {
        const original = { chatId: 'original', role: 'char', data: 'original response' }
        const workflowBase = { id: 'room-1', message: [original] }
        const stored = {
            id: 'room-1',
            message: [{
                ...original,
                chatId: 'client-a-result',
                data: 'client A response',
                swipes: ['original response', 'client A response'],
                swipeId: 1,
                swipeMetadata: [
                    { chatId: 'original' },
                    { chatId: 'client-a-result' },
                ],
            }],
        }
        const staleCanonical = {
            id: 'room-1',
            message: [{
                ...original,
                chatId: 'client-b-result',
                data: 'client B response',
                swipes: ['original response', 'client B response'],
                swipeId: 1,
                swipeMetadata: [
                    { chatId: 'original' },
                    { chatId: 'client-b-result' },
                ],
            }],
        }
        const repository = {
            getGenerationJob: () => ({
                jobId: 'job-b', workflowId: 'workflow-b', characterId: 'character-1',
                roomId: 'room-1', chatId: 'client-b-result', status: 'generated', createdAt: 2,
                rerollSnapshot: { targetMessage: original, targetIndex: 0, trailingMessages: [] },
            }),
            getGenerationWorkflow: () => ({
                workflowId: 'workflow-b',
                context: {
                    inputCommit: { chat: workflowBase },
                    postprocess: {
                        messageChatId: 'client-b-result',
                        rerollSnapshot: { targetMessage: original, targetIndex: 0, trailingMessages: [] },
                    },
                },
                steps: [
                    {
                        key: 'input.commit', status: 'completed',
                        metadata: { schemaVersion: 1, etag: computeChatEtag(workflowBase) },
                    },
                    {
                        key: 'postprocess', status: 'completed', metadata: { chat: staleCanonical },
                    },
                ],
            }),
            getEarlierRecoverableGenerationWorkflowJob: () => undefined,
            markGenerationMaterialized: () => true,
            updateGenerationWorkflowStep: vi.fn(),
        }
        const service = createRevenantMaterializer({
            repository,
            canonicalChatService: {
                commitGenerationResult: vi.fn(async () => {
                    throw Object.assign(new Error('generation merge conflict'), { httpStatus: 409 })
                }),
            },
        })

        await expect(service.materialize('job-b')).rejects.toMatchObject({
            name: 'RevenantMaterializationError',
            status: 409,
        })
    })

    it('refreshes a stale client checkpoint from the complete journal before materializing cancellation', async () => {
        const original = {
            role: 'char', data: 'original', chatId: 'original-message',
            swipes: ['original'], swipeId: 0,
        }
        const inputChat = {
            id: 'room-1',
            message: [
                { role: 'user', data: 'hello', chatId: 'user-message' },
                original,
            ],
        }
        const rerollSnapshot = {
            targetMessage: original,
            targetIndex: 1,
            trailingMessages: [],
        }
        const job = {
            jobId: 'job-1', workflowId: 'workflow-1', jobType: 'model',
            characterId: 'character-1', roomId: 'room-1', chatId: 'partial-message',
            status: 'cancelled', rawBytes: 80, streaming: true,
            adapterKind: 'openai-compatible', responseStatus: 200,
            responseHeaders: { 'content-type': 'text/event-stream' },
            projection: {
                schemaVersion: 1,
                source: 'client',
                adapterKind: 'openai-compatible',
                content: 'before refresh',
            },
            rerollSnapshot,
        }
        const workflow = {
            workflowId: 'workflow-1', status: 'cancelled',
            context: {
                inputCommit: { chat: inputChat },
                postprocess: {
                    chat: inputChat,
                    character: { chaId: 'character-1' },
                    messageChatId: 'partial-message',
                    isContinuation: false,
                    rerollSnapshot,
                },
            },
            steps: [{
                key: 'input.commit', status: 'completed',
                metadata: { etag: computeChatEtag(inputChat) },
            }],
        }
        const repository = {
            getGenerationWorkflow: () => workflow,
            listGenerationWorkflowJobs: () => [job],
            getEarlierRecoverableGenerationWorkflowJob: () => undefined,
            markGenerationMaterialized: vi.fn(() => true),
            readGenerationJobRaw: vi.fn(() => Buffer.from([
                'data: {"choices":[{"delta":{"content":"before refresh"}}]}',
                '',
                'data: {"choices":[{"delta":{"content":" after refresh"}}]}',
                '',
                'data: {"choices":[',
            ].join('\n'))),
            setGenerationJobProjection: vi.fn(() => true),
            setGenerationJobProjectionError: vi.fn(() => true),
        }
        const commitGenerationResult = vi.fn(async (input: any) => {
            await input.finalize()
            return { chat: input.chat }
        })
        const service = createRevenantMaterializer({
            repository,
            canonicalChatService: {
                commitGenerationResult,
                publishCurrent: vi.fn(),
            },
        })

        const result = await service.materializeCancellation('workflow-1')

        expect(result.message).toMatchObject({
            chatId: 'partial-message',
            data: 'before refresh after refresh',
            swipes: ['original', 'before refresh after refresh'],
            swipeId: 1,
        })
        expect(commitGenerationResult).toHaveBeenCalledWith(expect.objectContaining({
            job,
            workflow,
            chat: result.chat,
        }))
        expect(repository.markGenerationMaterialized).toHaveBeenCalledWith('job-1')
        expect(repository.setGenerationJobProjection).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({
                source: 'server',
                content: 'before refresh after refresh',
                journalBytes: expect.any(Number),
            }),
        )
    })

    it('keeps a user deletion that wins the cancelled reroll target race', async () => {
        const original = {
            role: 'char', data: 'original', chatId: 'original-message',
            swipes: ['original'], swipeId: 0,
        }
        const inputChat = {
            id: 'room-1',
            message: [
                { role: 'user', data: 'hello', chatId: 'user-message' },
                original,
            ],
        }
        const rerollSnapshot = {
            targetMessage: original,
            targetIndex: 1,
            trailingMessages: [],
        }
        const job = {
            jobId: 'job-1', workflowId: 'workflow-1', jobType: 'model',
            characterId: 'character-1', roomId: 'room-1', chatId: 'partial-message',
            status: 'cancelled', rawBytes: 10,
            projection: {
                schemaVersion: 1, source: 'server', adapterKind: 'openai-compatible',
                content: 'cancelled partial', journalBytes: 10,
            },
            rerollSnapshot,
        }
        const workflow = {
            workflowId: 'workflow-1', status: 'cancelled',
            context: {
                inputCommit: { chat: inputChat },
                postprocess: {
                    chat: inputChat,
                    character: { chaId: 'character-1' },
                    messageChatId: 'partial-message',
                    isContinuation: false,
                    rerollSnapshot,
                },
            },
            steps: [],
        }
        const repository = {
            getGenerationJob: () => job,
            getGenerationWorkflow: () => workflow,
            listGenerationWorkflowJobs: () => [job],
            getEarlierRecoverableGenerationWorkflowJob: () => undefined,
            markGenerationMaterialized: vi.fn(() => true),
            readGenerationJobRaw: vi.fn(() => Buffer.alloc(10)),
            updateGenerationWorkflowStep: vi.fn(),
        }
        const publishCurrent = vi.fn(async () => true)
        const service = createRevenantMaterializer({
            repository,
            canonicalChatService: {
                commitGenerationResult: vi.fn(async () => {
                    throw Object.assign(new Error('target changed'), {
                        httpStatus: 409,
                        conflicts: ['/message/original-message'],
                    })
                }),
                publishCurrent,
            },
        })

        await expect(service.materializeCancellation('workflow-1')).resolves.toEqual({
            success: true,
            discarded: true,
        })
        expect(repository.markGenerationMaterialized).toHaveBeenCalledWith('job-1')
        expect(publishCurrent).toHaveBeenCalledWith(
            'character-1',
            'room-1',
            'generation-cancelled-discarded',
        )
    })
})

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
            listRecoverableGenerationJobs: () => [],
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
            listRecoverableGenerationJobs: () => [],
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
})

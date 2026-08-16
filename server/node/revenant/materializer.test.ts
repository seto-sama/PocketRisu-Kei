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
        const fullChatStore = new Map([['character-1', new Map([['room-1', stored]])]])
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
        const persistDbCacheWithChats = vi.fn()
        const broadcastDatabaseInvalidated = vi.fn()
        const cachedDatabase = {
            characters: [{ chaId: 'character-1', desc: 'old description', chats: [] }],
            personaPrompt: 'old persona',
        }
        const service = createRevenantMaterializer({
            repository,
            queueStorageOperation: (operation: () => Promise<any>) => operation(),
            ensureChatStore: vi.fn(),
            getChatStorageState: () => ({
                fullChatStore, saveTimers: {}, dbCache: { db: cachedDatabase },
            }),
            databaseHexKey: 'db',
            persistDbCacheWithChats,
            createBackupAndRotate: vi.fn(),
            broadcastDatabaseInvalidated,
        })

        const result = await service.materialize('job-1')

        expect(result.message).toMatchObject({ data: 'server result', chatId: 'message-1' })
        expect(fullChatStore.get('character-1')?.get('room-1')).toEqual({ ...canonical, isStreaming: false })
        expect(persistDbCacheWithChats).toHaveBeenCalledWith('db', 'database/database.bin')
        expect(cachedDatabase.characters[0].desc).toBe('server description')
        expect(cachedDatabase.personaPrompt).toBe('server persona')
        expect(repository.updateGenerationWorkflowStep).toHaveBeenCalledWith(
            'workflow-1',
            'message.materialize',
            {
                status: 'running',
                metadata: { schemaVersion: 1, chat: expect.any(Object) },
            },
        )
        expect(materialized).toBe(true)
        expect(broadcastDatabaseInvalidated).toHaveBeenCalledOnce()
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
        const fullChatStore = new Map([['character-1', new Map([['room-1', stored]])]])
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
            queueStorageOperation: (operation: () => Promise<any>) => operation(),
            ensureChatStore: vi.fn(),
            getChatStorageState: () => ({ fullChatStore, saveTimers: {}, dbCache: { db: {} } }),
            databaseHexKey: 'db',
            persistDbCacheWithChats: vi.fn(),
            createBackupAndRotate: vi.fn(),
        })

        await expect(service.materialize('job-b')).rejects.toMatchObject({
            name: 'RevenantMaterializationError',
            status: 409,
        })
        expect(fullChatStore.get('character-1')?.get('room-1')).toEqual(stored)
    })

    it('materializes a cancelled reroll partial from the server journal projection', async () => {
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
        const fullChatStore = new Map([['character-1', new Map([['room-1', inputChat]])]])
        const repository = {
            getGenerationWorkflow: () => workflow,
            listGenerationWorkflowJobs: () => [job],
            markGenerationMaterialized: vi.fn(() => true),
            readGenerationJobRaw: vi.fn(() => Buffer.from([
                'data: {"choices":[{"delta":{"content":"partial response"}}]}',
                '',
                'data: {"choices":[',
            ].join('\n'))),
            setGenerationJobProjection: vi.fn(() => true),
            setGenerationJobProjectionError: vi.fn(() => true),
        }
        const broadcastDatabaseInvalidated = vi.fn()
        const service = createRevenantMaterializer({
            repository,
            queueStorageOperation: (operation: () => Promise<any>) => operation(),
            ensureChatStore: vi.fn(),
            getChatStorageState: () => ({ fullChatStore, saveTimers: {}, dbCache: { db: {} } }),
            databaseHexKey: 'db',
            persistDbCacheWithChats: vi.fn(),
            createBackupAndRotate: vi.fn(),
            broadcastDatabaseInvalidated,
        })

        const result = await service.materializeCancellation('workflow-1')

        expect(result.message).toMatchObject({
            chatId: 'partial-message',
            data: 'partial response',
            swipes: ['original', 'partial response'],
            swipeId: 1,
        })
        expect(fullChatStore.get('character-1')?.get('room-1')).toEqual(result.chat)
        expect(repository.markGenerationMaterialized).toHaveBeenCalledWith('job-1')
        expect(repository.setGenerationJobProjection).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({ source: 'server', content: 'partial response' }),
        )
        expect(broadcastDatabaseInvalidated).toHaveBeenCalledOnce()
    })
})

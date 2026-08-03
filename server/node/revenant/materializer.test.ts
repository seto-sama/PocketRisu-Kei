// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import materializerPkg from './materializer.cjs'

const { createRevenantMaterializer } = materializerPkg as {
    createRevenantMaterializer: (options: any) => { materialize: (jobId: string, input?: any) => Promise<any> }
}

describe('revenant canonical materializer', () => {
    it('persists the completed server trigger chat without a client message body', async () => {
        const stored = { id: 'room-1', message: [{ role: 'user', data: 'old' }] }
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
                steps: [{ key: 'trigger.output', status: 'completed', metadata: { chat: canonical } }],
            }),
            listRecoverableGenerationJobs: () => [],
            markGenerationMaterialized: () => { materialized = true; return true },
        }
        const persistDbCacheWithChats = vi.fn()
        const broadcastDatabaseInvalidated = vi.fn()
        const service = createRevenantMaterializer({
            repository,
            queueStorageOperation: (operation: () => Promise<any>) => operation(),
            ensureChatStore: vi.fn(),
            getChatStorageState: () => ({ fullChatStore, saveTimers: {}, dbCache: { db: {} } }),
            databaseHexKey: 'db',
            persistDbCacheWithChats,
            createBackupAndRotate: vi.fn(),
            broadcastDatabaseInvalidated,
        })

        const result = await service.materialize('job-1')

        expect(result.message).toMatchObject({ data: 'server result', chatId: 'message-1' })
        expect(fullChatStore.get('character-1')?.get('room-1')).toEqual({ ...canonical, isStreaming: false })
        expect(persistDbCacheWithChats).toHaveBeenCalledWith('db', 'database/database.bin')
        expect(materialized).toBe(true)
        expect(broadcastDatabaseInvalidated).toHaveBeenCalledOnce()
    })
})

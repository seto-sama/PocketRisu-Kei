import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHypaV3Preset, hypaMemoryV3 } from './hypav3'
import { requestChatData } from '../request/request'
import { reissueMessageIds } from '../../chatClone'
import { getMessagePromptIdentity } from '../../storage/messageIdentity'

const state = vi.hoisted(() => ({ db: {} as any }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => state.db, getCurrentCharacter: () => null }))
vi.mock('../request/request', () => ({ requestChatData: vi.fn(() => { throw new Error('Summary started before registration') }) }))
vi.mock('../request/modelPresetBinding', () => ({
    resolveChatModelBinding: () => ({ kind: 'modelPreset', preset: {
        id: 'summary', name: 'Summary', userValues: {},
        profileSnapshot: { adapterKind: 'echo', schema: [], capabilities: [], auth: { kind: 'none' } },
    } }),
}))
vi.mock('src/ts/parser/chatML', () => ({ parseChatML: () => null }))
vi.mock('src/ts/parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('src/ts/stores.svelte', () => ({ hypaV3ProgressStore: { set: vi.fn() } }))
vi.mock('src/ts/storage/chatStorage', () => ({ saveChatToServer: vi.fn() }))
vi.mock('../revenant/auxiliary', () => ({ resolveRecoverableAuxiliaryGenerations: async () => [], consumeRecoverableAuxiliaryGeneration: vi.fn() }))
vi.mock('../revenant', () => ({ createRevenantOperation: (value: unknown) => value, isRevenantHypaV3SummaryOperation: () => true }))
vi.mock('./hypamemory', () => ({ HypaProcesser: class {} }))
vi.mock('./hypaEmbeddingProcessor', () => ({ HypaEmbeddingProcessor: class {} }))
vi.mock('./contextualEmbedding', () => ({ isContextModel: () => true, getContextProvider: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

describe('Hypa planning before durable main registration', () => {
    it.each([false, true])('reuses branched memory when selected responses retain their provider IDs (experimental=%s)', async experimental => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        state.db = {
            hypaModel: 'openai3small', supaMemoryKey: 'test-key', hypaV3PresetId: 0,
            hypaV3Presets: [createHypaV3Preset('Test', {
                useExperimentalImpl: experimental, queryChatCount: 2,
                memoryTokensRatio: 0.3, extraSummarizationRatio: 0,
            })],
        }
        const source = {
            id: 'source', name: '', note: '', localLore: [],
            message: Array.from({ length: 8 }, (_, index) => ({
                role: 'char' as const, data: `message-${index}`, chatId: `memo-${index}`,
                swipes: [`message-${index}`], swipeId: 0,
                swipeMetadata: [{ chatId: `response-${index}` }],
            })),
            hypaV3Data: { summaries: [{
                text: 'existing summary', isImportant: false,
                chatMemos: Array.from({ length: 5 }, (_, index) => `memo-${index}`),
            }] },
        }
        const room = structuredClone(source)
        room.id = `branch-${experimental}`
        room.message = room.message.slice(0, 7)
        reissueMessageIds(room, source.message.map(message => message.chatId))
        const chats = room.message.map(message => ({
            role: 'assistant' as const, content: message.data, ...getMessagePromptIdentity(message),
        }))
        const tokenizer = { tokenizeChat: async () => 10, getRevenantSpec: () => ({ tokenizer: 'tik', chatAdditionalTokens: 0 }) }
        const result = await hypaMemoryV3(chats, 70, 50, room,
            { chaId: 'character' } as any, tokenizer as any,
            { planServerExecution: true, deferredMemoryPrompt: '__memory__' })

        expect(result.error).toBeUndefined()
        expect(result.serverExecution?.startIdx).toBe(5)
        expect(result.serverExecution?.summaryRequests).toEqual([])
        expect(result.memory?.summaries).toEqual(room.hypaV3Data.summaries)
        expect(result.chats.slice(1).map(chat => chat.responseId)).toEqual(['response-5', 'response-6'])
    })

    it.each([false, true].flatMap(experimental =>
        ['voyageContext3', 'openai3small', 'custom'].map(model => ({ experimental, model })),
    ))('plans every summary without starting requests ($model, experimental=$experimental)', async ({ experimental, model }) => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const hypaPreset = createHypaV3Preset('Test', {
            useExperimentalImpl: experimental, maxChatsPerSummary: 2, queryChatCount: 2,
            summarizationMaxConcurrent: 3, embeddingMaxConcurrent: 4,
            memoryTokensRatio: 0.3, extraSummarizationRatio: 0,
            recentMemoryRatio: 0.5, similarMemoryRatio: 0.5,
        })
        state.db = { hypaModel: model, voyageApiKey: 'test-key', supaMemoryKey: 'test-key',
            hypaCustomSettings: { url: 'https://embedding.example/v1/embeddings', key: 'test-key', model: 'custom-model' },
            hypaV3Presets: [hypaPreset], hypaV3PresetId: 0 }
        const chats = [
            { role: 'assistant' as const, content: 'greeting' },
            ...Array.from({ length: 7 }, (_, index) => ({
                role: 'user' as const, content: `message-${index}`, memo: `memo-${index}`,
            })),
        ]
        const tokenizer = { tokenizeChat: async () => 20, getRevenantSpec: () => ({ tokenizer: 'tik', chatAdditionalTokens: 0 }) }
        const result = await hypaMemoryV3(chats, 190, 100, { id: `room-${experimental}` } as any,
            { chaId: 'character' } as any, tokenizer as any,
            { planServerExecution: true, deferredMemoryPrompt: '__memory__' })
        expect(result.error).toBeUndefined()
        expect(result.deferredRemoteSelection).toBe(true)
        expect(result.serverExecution?.summaryDispatch).toEqual({ maxConcurrent: 3 })
        expect(result.serverExecution).toMatchObject({
            embedding: { model },
            settings: {
                embeddingMaxConcurrent: 4,
                queryMode: experimental ? 'paragraph' : 'chat',
            },
        })
        const requests = result.serverExecution!.summaryRequests as any[]
        expect(requests.filter(request => request.purpose === 'memory')).toHaveLength(3)
        expect(requests[0].chatMemos).toEqual([null, 'memo-0'])
        expect(result.chats[0]).toMatchObject({ memo: 'supaMemory', content: '__memory__' })
        expect(requestChatData).not.toHaveBeenCalled()
    })
})

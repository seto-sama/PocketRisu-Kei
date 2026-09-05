import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHypaV3Preset, hypaMemoryV3 } from './hypav3'
import { requestChatData } from '../request/request'
import { prepareRevenantHypaExecution } from '../revenant/workflow'

const state = vi.hoisted(() => ({ db: {} as any }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => state.db, getCurrentCharacter: () => null }))
vi.mock('../request/request', () => ({ requestChatData: vi.fn(() => { throw new Error('Summary started before registration') }) }))
vi.mock('../request/modelPresetBinding', () => ({
    resolveChatMaxResponseTokens: () => 0,
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
vi.mock('../revenant/workflow', () => ({
    getRevenantHypaExecution: async () => null, prepareRevenantHypaExecution: vi.fn(), waitForRevenantHypaExecution: vi.fn(),
}))
vi.mock('./hypamemory', () => ({ HypaProcesser: class {} }))
vi.mock('./hypamemoryv2', () => ({ HypaProcessorV2: class {} }))
vi.mock('./contextualEmbedding', () => ({ isContextModel: () => true, getContextProvider: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

describe('Hypa planning before durable main registration', () => {
    it.each([false, true].flatMap(experimental =>
        ['voyageContext3', 'openai3small', 'custom'].map(model => ({ experimental, model })),
    ))('plans every summary without starting requests ($model, experimental=$experimental)', async ({ experimental, model }) => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const hypaPreset = createHypaV3Preset('Test', {
            useExperimentalImpl: experimental, maxChatsPerSummary: 2, queryChatCount: 2,
            memoryTokensRatio: 0.3, extraSummarizationRatio: 0,
            recentMemoryRatio: 0.5, similarMemoryRatio: 0.5,
        })
        state.db = { hypaModel: model, voyageApiKey: 'test-key', supaMemoryKey: 'test-key',
            hypaCustomSettings: { url: 'https://embedding.example/v1/embeddings', key: 'test-key', model: 'custom-model' },
            hypaV3Presets: [hypaPreset], hypaV3PresetId: 0 }
        const chats = Array.from({ length: 8 }, (_, index) => ({ role: 'user' as const, content: `message-${index}`, memo: `memo-${index}` }))
        const tokenizer = { tokenizeChat: async () => 20, getRevenantSpec: () => ({ tokenizer: 'tik', chatAdditionalTokens: 0 }) }
        const result = await hypaMemoryV3(chats, 190, 100, { id: `room-${experimental}` } as any,
            { chaId: 'character' } as any, tokenizer as any,
            { planServerExecution: true, deferredMemoryPrompt: '__memory__' })
        expect(result.error).toBeUndefined()
        expect(result.deferredRemoteSelection).toBe(true)
        expect(result.serverExecution).toMatchObject({
            embedding: { model },
            settings: { queryMode: experimental ? 'paragraph' : 'chat' },
        })
        const requests = result.serverExecution!.summaryRequests as any[]
        expect(requests.filter(request => request.purpose === 'memory')).toHaveLength(3)
        expect(result.chats[0]).toMatchObject({ memo: 'supaMemory', content: '__memory__' })
        expect(requestChatData).not.toHaveBeenCalled()
        expect(prepareRevenantHypaExecution).not.toHaveBeenCalled()
    })
})

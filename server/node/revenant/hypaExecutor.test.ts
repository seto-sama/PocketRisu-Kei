import { describe, expect, it, vi } from 'vitest'
import executorPkg from './hypaExecutor.cjs'

const { createRemoteEmbedder, selectHypaMemory } = executorPkg as {
    createRemoteEmbedder: (
        config: Record<string, unknown>,
        deps: Record<string, unknown>,
    ) => {
        documents: (items: Array<{ content: string, summaryIndex: number }>) => Promise<number[][]>
        queries: (items: string[]) => Promise<number[][]>
    }
    selectHypaMemory: (
        recipe: Record<string, any>,
        summaries: Array<Record<string, any>>,
        deps: Record<string, unknown>,
    ) => Promise<Record<string, any>>
}

function recipe() {
    return {
        tokenizer: { tokenizer: 'tik', chatAdditionalTokens: 0 },
        embedding: { model: 'openai3small', apiKey: 'secret' },
        settings: {
            recentMemoryRatio: 0,
            similarMemoryRatio: 1,
            queryChatCount: 1,
            summaryChunkSeparator: '\\n\\n',
        },
        memory: { summaries: [] },
        chats: [
            { role: 'user', content: 'old', memo: 'old' },
            { role: 'user', content: 'query', memo: 'query' },
        ],
        startIdx: 1,
        currentTokens: 10,
        maxContextTokens: 100,
        availableMemoryTokens: 2,
        memoryTokens: 4,
        shouldReserveMemoryTokens: true,
        randomSeed: 'stable',
    }
}

describe('server HypaV3 selection executor', () => {
    it('selects important and semantically similar summaries and creates a resumable checkpoint', async () => {
        const summaries = [
            { text: 'important', chatMemos: ['a'], isImportant: true },
            { text: 'matching', chatMemos: ['b'], isImportant: false },
            { text: 'other', chatMemos: ['c'], isImportant: false },
        ]
        const result = await selectHypaMemory(recipe(), summaries, {
            tokenize: async () => 1,
            embedder: {
                documents: async () => [[1, 0], [0, 1]],
                queries: async () => [[1, 0]],
            },
        })

        expect(result.currentTokens).toBe(7)
        expect(result.memory.metrics.lastImportantSummaries).toEqual([0])
        expect(result.memory.metrics.lastSimilarSummaries).toEqual([1])
        expect(result.chatSequence[0].chat.content).toContain('important\n\nmatching')
        expect(result.chatSequence[1]).toEqual({ inputIndex: 1, inputMemo: 'query' })
    })

    it('uses the OpenAI embeddings endpoint for every remote embedding phase', async () => {
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body))
            return new Response(JSON.stringify({
                data: body.input.map((_: string, index: number) => ({ embedding: [index, 1] })),
            }), { status: 200, headers: { 'content-type': 'application/json' } })
        })
        const embedder = createRemoteEmbedder(
            { model: 'openai3large', apiKey: 'openai-key' },
            { fetch: fetchMock },
        )

        await embedder.documents([{ content: 'doc', summaryIndex: 0 }])
        await embedder.queries(['query'])

        expect(fetchMock).toHaveBeenCalledTimes(2)
        for (const [url, init] of fetchMock.mock.calls) {
            expect(url).toBe('https://api.openai.com/v1/embeddings')
            expect((init.headers as Record<string, string>).authorization).toBe('Bearer openai-key')
            expect(JSON.parse(String(init.body)).model).toBe('text-embedding-3-large')
        }
    })
})

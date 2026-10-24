import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPersistedHypaVectors, HypaProcesser, setPersistedHypaVector, hypaVectorCache, truncateErrorBody } from './hypamemory'
import { readPersistentJsonBatch } from 'src/ts/storage/persistentKv'
import { globalFetch } from 'src/ts/globalApi.svelte'
import { createClientHypaEmbedder } from './hypaSelectionEmbedder'
import { TaskConcurrencyLimiter } from './taskConcurrencyLimiter'
import { isLocalNetworkUrl } from 'src/ts/network/localNetwork'
import { getContextProvider } from './contextualEmbedding'

const state = vi.hoisted(() => ({ db: {} as Record<string, any> }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => state.db }))
vi.mock('src/ts/globalApi.svelte', () => ({ globalFetch: vi.fn() }))
vi.mock('src/ts/storage/persistentKv', () => ({
    makeHashedStorageKey: vi.fn(async (_prefix: string, key: string) => key),
    readPersistentJsonBatch: vi.fn(async () => new Map()),
    writePersistentJson: vi.fn(async () => undefined),
}))
vi.mock('./contextualEmbedding', () => ({
    isContextModel: () => false,
    getContextProvider: vi.fn(() => null),
}))
vi.mock('src/ts/network/localNetwork', () => ({ isLocalNetworkUrl: vi.fn(() => false) }))
vi.mock('src/ts/util', () => ({
    appendLastPath: (base: string, path: string) => `${base}/${path}`,
}))

describe('Hypa embedding infrastructure', () => {
    beforeEach(() => {
        hypaVectorCache.clear()
        vi.clearAllMocks()
        state.db = {
            hypaModel: 'custom',
            hypaCustomSettings: { url: '', key: '', model: '' },
            supaMemoryKey: '',
            voyageApiKey: '',
        }
    })

    const embedder = () => createClientHypaEmbedder(new TaskConcurrencyLimiter({ maxConcurrentTasks: 1 }))

    it('bounds the shared vector cache without losing persisted embeddings', async () => {
        for (let index = 0; index < 600; index++) {
            await setPersistedHypaVector(String(index), { content: String(index), embedding: [1, 0] })
        }
        expect(hypaVectorCache.size).toBeLessThan(600)
        expect(hypaVectorCache.has('0')).toBe(false)
        vi.mocked(readPersistentJsonBatch).mockResolvedValueOnce(new Map([
            ['0', { key: '0', value: { content: '0', embedding: [1, 0] } }],
        ]))
        expect(await getPersistedHypaVectors(['0'])).toEqual([{ content: '0', embedding: [1, 0] }])
        hypaVectorCache.clear()

        const keys = Array.from({ length: 600 }, (_, index) => String(index))
        vi.mocked(readPersistentJsonBatch).mockResolvedValueOnce(new Map(keys.map(key => [
            key, { key, value: { content: key, embedding: [1, 0] } },
        ])))
        const loaded = await getPersistedHypaVectors(keys)
        expect(loaded.map(vector => vector?.content)).toEqual(keys)
        expect(hypaVectorCache.size).toBeLessThan(keys.length)
        expect(hypaVectorCache.has('0')).toBe(false)
    })

    it('reads only memory misses in one batch, preserves order, and rejects mismatched stored keys', async () => {
        const warm = { content: 'warm', embedding: [1, 0] }
        const persisted = { content: 'persisted', embedding: [0, 1] }
        hypaVectorCache.set('warm', warm)
        vi.mocked(readPersistentJsonBatch).mockResolvedValueOnce(new Map([
            ['wrong', { key: 'other', value: warm }],
            ['persisted', { key: 'persisted', value: persisted }],
        ]))

        expect(await getPersistedHypaVectors(['persisted', 'warm', 'missing', 'wrong', 'persisted']))
            .toEqual([persisted, warm, undefined, undefined, persisted])
        expect(readPersistentJsonBatch).toHaveBeenCalledTimes(1)
        expect(vi.mocked(readPersistentJsonBatch).mock.calls[0][0]).toEqual(['persisted', 'missing', 'wrong'])

        vi.mocked(readPersistentJsonBatch).mockClear()
        expect(await getPersistedHypaVectors(['warm', 'persisted'])).toEqual([warm, persisted])
        expect(await getPersistedHypaVectors([])).toEqual([])
        expect(readPersistentJsonBatch).not.toHaveBeenCalled()
    })

    it('shares the vector cache between the processor and the selection embedder', async () => {
        const warm = { content: 'warm', embedding: [1, 0] }
        const persisted = { content: 'persisted', embedding: [0, 1] }
        hypaVectorCache.set('warm|custom', warm)
        vi.mocked(readPersistentJsonBatch).mockResolvedValueOnce(new Map([
            ['persisted|custom', { key: 'persisted|custom', value: persisted }],
        ]))
        const processor = new HypaProcesser('custom', 'https://embedding.test')
        const embed = vi.spyOn(processor, 'embedDocuments').mockResolvedValue([[1, 1]])
        await processor.addText(['warm', 'persisted', 'missing', 'warm'])
        expect(embed).toHaveBeenCalledWith(['missing'])
        expect(processor.vectors.map(vector => vector.content).sort()).toEqual(['missing', 'persisted', 'warm'])
        expect(readPersistentJsonBatch).toHaveBeenCalledTimes(1)
        await processor.addText(['warm', 'persisted', 'missing'])
        expect(processor.vectors).toHaveLength(3)
        expect(embed).toHaveBeenCalledTimes(1)
        expect(readPersistentJsonBatch).toHaveBeenCalledTimes(1)
        vi.mocked(globalFetch).mockResolvedValueOnce({
            ok: true, data: { data: [{ embedding: [0, 1] }] },
        } as any)
        expect((await processor.similaritySearchScored('query')).map(([, score]) => score)).toEqual([1, 1, 0])

        hypaVectorCache.clear()
        vi.mocked(readPersistentJsonBatch).mockClear()
        vi.mocked(readPersistentJsonBatch).mockResolvedValueOnce(new Map([
            ['persisted|custom', { key: 'persisted|custom', value: persisted }],
            ['warm|custom', { key: 'warm|custom', value: warm }],
        ]))
        const vectors = await embedder().documents([
            { content: 'warm', summaryIndex: 0 },
            { content: 'persisted', summaryIndex: 1 },
        ])
        expect(vectors).toEqual([warm.embedding, persisted.embedding])
        expect(readPersistentJsonBatch).toHaveBeenCalledTimes(1)
    })

    it('keeps memory hits when persistent lookup fails and embeds only the remaining texts', async () => {
        hypaVectorCache.set('warm|custom', { content: 'warm', embedding: [1, 0] })
        vi.mocked(readPersistentJsonBatch).mockRejectedValueOnce(new Error('cache unavailable'))
        vi.mocked(globalFetch).mockResolvedValueOnce({
            ok: true, data: { data: [{ embedding: [0, 1] }] },
        } as any)
        vi.mocked(isLocalNetworkUrl).mockReturnValueOnce(true)
        state.db.hypaCustomSettings.url = 'http://localhost:8000'
        const vectors = await embedder().documents([
            { content: 'warm', summaryIndex: 0 },
            { content: 'missing', summaryIndex: 0 },
        ])

        expect(vi.mocked(globalFetch).mock.calls[0][1]).toMatchObject({
            body: { input: ['missing'] },
            networkRoute: 'local_network',
        })
        expect(vectors).toEqual([[1, 0], [0, 1]])
    })

    it('uses the shared Voyage request path for document and query embeddings', async () => {
        state.db.hypaModel = 'voyage4large'
        state.db.voyageApiKey = 'key'
        vi.mocked(globalFetch).mockResolvedValue({
            ok: true, data: { data: [{ embedding: [1, 0] }] },
        } as any)
        const selectionEmbedder = embedder()
        await selectionEmbedder.documents([{ content: 'document', summaryIndex: 0 }])
        expect(globalFetch).toHaveBeenLastCalledWith('https://api.voyageai.com/v1/embeddings',
            expect.objectContaining({ body: { input: ['document'], model: 'voyage-4-large', input_type: 'document' } }))

        await selectionEmbedder.queries(['query'])
        expect(globalFetch).toHaveBeenLastCalledWith('https://api.voyageai.com/v1/embeddings',
            expect.objectContaining({ body: expect.objectContaining({ model: 'voyage-4-large', input_type: 'query' }) }))
    })

    it('bounds document and query embedding together by the configured concurrency', async () => {
        state.db.hypaCustomSettings.url = 'https://embedding.test'
        let active = 0
        let peak = 0
        vi.mocked(globalFetch).mockImplementation(async (_url, init: any) => {
            active++
            peak = Math.max(peak, active)
            await new Promise(resolve => setTimeout(resolve, 1))
            active--
            return { ok: true, data: { data: init.body.input.map(() => ({ embedding: [1, 0] })) } } as any
        })
        const selectionEmbedder = embedder()

        await Promise.all([
            selectionEmbedder.documents([{ content: 'document', summaryIndex: 0 }]),
            selectionEmbedder.queries(['query']),
        ])

        expect(globalFetch).toHaveBeenCalledTimes(2)
        expect(peak).toBe(1)
    })

    it('keeps a separate contextual vector for each repeated chunk', async () => {
        state.db.hypaModel = 'voyageContext3'
        const embedDocumentGroups = vi.fn(async (groups: string[][]) =>
            groups.map(group => group.map((_, position) => [position, 1])))
        vi.mocked(getContextProvider).mockReturnValue({
            modelId: 'voyage-context-3',
            embedDocumentGroups,
            embedQueries: vi.fn(),
            getCacheKeySuffix: (texts?: string[]) => `|ctx:${texts?.length}`,
        })
        const chunks = [
            { content: 'same', summaryIndex: 0 },
            { content: 'same', summaryIndex: 0 },
            { content: 'same', summaryIndex: 1 },
        ]

        expect(await embedder().documents(chunks)).toEqual([[0, 1], [1, 1], [0, 1]])
        expect(embedDocumentGroups).toHaveBeenCalledWith([['same', 'same'], ['same']])
        expect([...hypaVectorCache.keys()]).toEqual(['same|ctx:2|chunk:0', 'same|ctx:2|chunk:1', 'same|ctx:1'])

        expect(await embedder().documents(chunks)).toEqual([[0, 1], [1, 1], [0, 1]])
        expect(embedDocumentGroups).toHaveBeenCalledTimes(1)
    })

    it('bounds embedding error text surfaced to the UI', () => {
        const result = truncateErrorBody('x'.repeat(500))
        expect(truncateErrorBody('short error')).toBe('short error')
        expect(result.length).toBeLessThan(500)
        expect(result).toContain('(500 chars)')
    })

    it('bounds concurrent tasks while preserving result order', async () => {
        let active = 0
        let peak = 0
        const limiter = new TaskConcurrencyLimiter({ maxConcurrentTasks: 2 })
        const batch = await limiter.executeBatch([3, 1, 2].map(value => async () => {
            active++
            peak = Math.max(peak, active)
            await new Promise(resolve => setTimeout(resolve, value))
            active--
            return value
        }))

        expect(peak).toBe(2)
        expect(batch.results.map(result => result.data)).toEqual([3, 1, 2])
    })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPersistedHypaVector, getPersistedHypaVectors, HypaProcesser, setPersistedHypaVector, hypaVectorCache, truncateErrorBody } from './hypamemory'
import { readPersistentJsonBatch } from 'src/ts/storage/persistentKv'
import { globalFetch } from 'src/ts/globalApi.svelte'
import { HypaEmbeddingProcessor } from './hypaEmbeddingProcessor'
import { TaskConcurrencyLimiter } from './taskConcurrencyLimiter'
import { isLocalNetworkUrl } from 'src/ts/network/localNetwork'

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => ({
        hypaModel: 'custom',
        hypaCustomSettings: { url: '', key: '', model: '' },
        supaMemoryKey: '',
        voyageApiKey: '',
    }),
}))
vi.mock('src/ts/globalApi.svelte', () => ({ globalFetch: vi.fn() }))
vi.mock('src/ts/storage/persistentKv', () => ({
    makeHashedStorageKey: vi.fn(async (_prefix: string, key: string) => key),
    readPersistentJsonBatch: vi.fn(async () => new Map()),
    writePersistentJson: vi.fn(async () => undefined),
}))
vi.mock('./contextualEmbedding', () => ({
    isContextModel: () => false,
    getContextProvider: () => null,
}))
vi.mock('src/ts/network/localNetwork', () => ({ isLocalNetworkUrl: vi.fn(() => false) }))
vi.mock('src/ts/util', () => ({
    appendLastPath: (base: string, path: string) => `${base}/${path}`,
}))

describe('Hypa embedding infrastructure', () => {
    beforeEach(() => {
        hypaVectorCache.clear()
        vi.clearAllMocks()
    })

    it('bounds the shared vector cache without losing persisted embeddings', async () => {
        for (let index = 0; index < 600; index++) {
            await setPersistedHypaVector(String(index), { content: String(index), embedding: [1, 0] })
        }
        expect(hypaVectorCache.size).toBeLessThan(600)
        expect(hypaVectorCache.has('0')).toBe(false)
        vi.mocked(readPersistentJsonBatch).mockResolvedValueOnce(new Map([
            ['0', { key: '0', value: { content: '0', embedding: [1, 0] } }],
        ]))
        expect(await getPersistedHypaVector('0')).toEqual({ content: '0', embedding: [1, 0] })
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

    it('shares batch lookup in both processors and embeds only uncached texts', async () => {
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
        const embeddingProcessor = new HypaEmbeddingProcessor({ model: 'custom' })
        await embeddingProcessor.addTexts([
            { id: 'first', content: 'warm' },
            { id: 'second', content: 'persisted' },
        ])
        expect(embeddingProcessor.vectors.get('first')?.embedding).toEqual(warm.embedding)
        expect(embeddingProcessor.vectors.get('second')?.embedding).toEqual(persisted.embedding)
        expect(readPersistentJsonBatch).toHaveBeenCalledTimes(1)
    })

    it('keeps memory hits when persistent lookup fails and embeds only the remaining texts', async () => {
        hypaVectorCache.set('warm|custom', { content: 'warm', embedding: [1, 0] })
        vi.mocked(readPersistentJsonBatch).mockRejectedValueOnce(new Error('cache unavailable'))
        vi.mocked(globalFetch).mockResolvedValueOnce({
            ok: true, data: { data: [{ embedding: [0, 1] }] },
        } as any)
        vi.mocked(isLocalNetworkUrl).mockReturnValueOnce(true)
        const processor = new HypaEmbeddingProcessor({ model: 'custom', customEmbeddingUrl: 'http://localhost:8000' })
        await processor.addTexts([
            { id: 'first', content: 'warm' },
            { id: 'second', content: 'missing' },
        ])

        expect(vi.mocked(globalFetch).mock.calls[0][1]).toMatchObject({
            body: { input: ['missing'] },
            networkRoute: 'local_network',
        })
        expect(processor.vectors.get('first')?.embedding).toEqual([1, 0])
        expect(processor.vectors.get('second')?.embedding).toEqual([0, 1])
    })

    it('attaches metadata to a detached result instead of mutating the shared cache', async () => {
        const shared = { content: 'same text', embedding: [1, 0] }
        hypaVectorCache.set('same text|custom', shared)
        const processor = new HypaEmbeddingProcessor<{ summary: string }>({ model: 'custom' })

        await processor.addTexts([{
            id: 'summary-vector',
            content: 'same text',
            metadata: { summary: 'kept' },
        }])

        const stored = processor.vectors.get('summary-vector')
        expect(stored?.metadata).toEqual({ summary: 'kept' })
        expect(shared).not.toHaveProperty('metadata')

        await processor.similaritySearchScoredBatch(['same text'])
        expect(processor.vectors.get('summary-vector')?.metadata).toEqual({ summary: 'kept' })
        expect(shared).not.toHaveProperty('metadata')
    })

    it('uses the shared Voyage request path for document and query embeddings', async () => {
        for (const processor of [
            new HypaProcesser('voyage4large'),
            new HypaEmbeddingProcessor({ model: 'voyage4large' }),
        ]) {
            hypaVectorCache.clear()
            vi.mocked(globalFetch).mockResolvedValueOnce({
                ok: true, data: { data: [{ embedding: [1, 0] }] },
            } as any)
            if (processor instanceof HypaProcesser) {
                await processor.addText(['document'])
            } else {
                await processor.addTexts([{ id: 'doc', content: 'document' }])
            }
            expect(globalFetch).toHaveBeenLastCalledWith('https://api.voyageai.com/v1/embeddings',
                expect.objectContaining({ body: { input: ['document'], model: 'voyage-4-large', input_type: 'document' } }))

            vi.mocked(globalFetch).mockResolvedValueOnce({
                ok: true, data: { data: [{ embedding: [1, 0] }] },
            } as any)
            if (processor instanceof HypaProcesser) {
                await processor.similaritySearchScored('query')
            } else {
                await processor.similaritySearchScoredBatch(['query'])
            }
            expect(globalFetch).toHaveBeenLastCalledWith('https://api.voyageai.com/v1/embeddings',
                expect.objectContaining({ body: expect.objectContaining({ model: 'voyage-4-large', input_type: 'query' }) }))
        }
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

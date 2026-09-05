import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    readPersistentJson: vi.fn(async () => undefined),
    writePersistentJson: vi.fn(async () => undefined),
}))
vi.mock('./contextualEmbedding', () => ({
    isContextModel: () => false,
    getContextProvider: () => null,
}))
vi.mock('src/ts/network/localNetwork', () => ({ isLocalNetworkUrl: () => false }))
vi.mock('src/ts/platform', () => ({ isMobile: false }))
vi.mock('src/ts/util', () => ({
    appendLastPath: (base: string, path: string) => `${base}/${path}`,
}))

import { hypaVectorCache, truncateErrorBody } from './hypamemory'
import { HypaProcessorV2 } from './hypamemoryv2'

describe('HypaProcessorV2 shared cache', () => {
    beforeEach(() => {
        hypaVectorCache.clear()
    })

    it('attaches metadata to a detached result instead of mutating the shared cache', async () => {
        const shared = { content: 'same text', embedding: [1, 0] }
        hypaVectorCache.set('same text|custom', shared)
        const processor = new HypaProcessorV2<{ summary: string }>({ model: 'custom' })

        await processor.addTexts([{
            id: 'summary-vector',
            content: 'same text',
            metadata: { summary: 'kept' },
        }])

        const stored = processor.vectors.get('summary-vector')
        expect(stored).not.toBe(shared)
        expect(stored?.metadata).toEqual({ summary: 'kept' })
        expect(shared).not.toHaveProperty('metadata')

        // A metadata-less query hitting the same shared entry must not clear
        // the metadata already held by the saved summary vector.
        await processor.similaritySearchScored('same text')
        expect(processor.vectors.get('summary-vector')?.metadata).toEqual({ summary: 'kept' })
        expect(shared).not.toHaveProperty('metadata')
    })

    it('bounds embedding error text surfaced to the UI', () => {
        const result = truncateErrorBody('x'.repeat(500))
        expect(result.length).toBeLessThan(340)
        expect(result).toContain('(500 chars)')
    })
})

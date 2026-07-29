import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDb } = vi.hoisted(() => ({ mockDb: { db: {} as any } }))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb.db,
}))

import {
    addApiKey,
    getApiKey,
    getDefaultApiKeyRef,
    listApiKeyProviderOptions,
    listApiKeys,
    removeApiKey,
    updateApiKey,
} from './apiKeyPool'

let clock = 1000
beforeEach(() => {
    mockDb.db = { apiKeyPool: {} }
    clock = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => clock++)
})

describe('apiKeyPool', () => {
    it('adds a key and returns it via getApiKey', () => {
        const entry = addApiKey({ name: 'My OpenAI', key: 'sk-123', provider: 'openai' })
        expect(entry.id).toBeTruthy()
        expect(entry.order).toBe(0)
        expect(getApiKey(entry.id)).toEqual(entry)
        expect(mockDb.db.apiKeyPool[entry.id]).toEqual(entry)
    })

    it('appends after the highest order without colliding with gaps', () => {
        mockDb.db.apiKeyPool = {
            first: { id: 'first', name: 'first', key: 'k1', order: 0, createdAt: 1, updatedAt: 1 },
            third: { id: 'third', name: 'third', key: 'k3', order: 2, createdAt: 3, updatedAt: 3 },
        }

        const entry = addApiKey({ name: 'fourth', key: 'k4' })

        expect(entry.order).toBe(3)
        expect(listApiKeys().map((e) => e.name)).toEqual(['first', 'third', 'fourth'])
    })

    it('reassigns apiKeyPool to a new object reference on mutation (Svelte reactivity)', () => {
        const before = mockDb.db.apiKeyPool
        addApiKey({ name: 'k', key: 'sk-1' })
        expect(mockDb.db.apiKeyPool).not.toBe(before)
    })

    it('initialises the pool when undefined', () => {
        mockDb.db = {} // no apiKeyPool
        const entry = addApiKey({ name: 'k', key: 'sk-1' })
        expect(mockDb.db.apiKeyPool[entry.id]).toEqual(entry)
    })

    it('filters by provider and falls back to all when omitted', () => {
        addApiKey({ name: 'a', key: 'k1', provider: 'openai' })
        addApiKey({ name: 'b', key: 'k2', provider: 'anthropic' })
        addApiKey({ name: 'c', key: 'k3' }) // untagged
        expect(listApiKeys('openai').map((e) => e.name)).toEqual(['a'])
        expect(listApiKeys().length).toBe(3)
    })

    it('keeps similar provider ids in separate credential scopes', () => {
        const hosted = addApiKey({ name: 'hosted', key: 'hosted-key', provider: 'acme-hosted' })
        const direct = addApiKey({ name: 'direct', key: 'direct-key', provider: 'acme-direct' })

        expect(hosted.provider).toBe('acme-hosted')
        expect(direct.provider).toBe('acme-direct')
        expect(listApiKeys('acme-hosted').map((entry) => entry.name)).toEqual(['hosted'])
        expect(listApiKeys('acme-direct').map((entry) => entry.name)).toEqual(['direct'])
        expect(listApiKeys('acme')).toEqual([])
    })

    it('shares one Cloudflare API token across Workers AI and AI Gateway', () => {
        const cloudflare = addApiKey({
            name: 'Cloudflare',
            key: 'cf-token',
            provider: 'cloudflare-workers-ai',
        })

        expect(cloudflare.provider).toBe('cloudflare')
        expect(listApiKeys('cloudflare-workers-ai').map((entry) => entry.name))
            .toEqual(['Cloudflare'])
        expect(listApiKeys('cloudflare-ai-gateway').map((entry) => entry.name))
            .toEqual(['Cloudflare'])
    })

    it('filters new-key providers by model provider visibility with explicit exceptions', () => {
        const baseProviders = {
            hosted: {
                id: 'acme-hosted',
                displayName: 'Acme Hosted',
                providerGroupId: 'acme-hosted',
                providerGroupDisplayName: 'Acme Hosted',
            },
            models: {
                id: 'acme-models',
                displayName: 'Acme Models',
                providerGroupId: 'acme-models',
                providerGroupDisplayName: 'Acme Models',
            },
            workers: {
                id: 'cloudflare-workers-ai',
                displayName: 'Cloudflare Workers AI',
                providerGroupId: 'cloudflare-workers-ai',
            },
            gateway: {
                id: 'cloudflare-ai-gateway',
                displayName: 'Cloudflare AI Gateway',
                providerGroupId: 'cloudflare-ai-gateway',
            },
        } as any

        const options = listApiKeyProviderOptions(
            baseProviders,
            new Set(['acme-hosted', 'cloudflare-workers-ai']),
        )

        expect(options.map((option) => option.id)).toEqual(
            expect.arrayContaining(['acme-models', 'cloudflare', 'voyage', 'novelai']),
        )
        expect(options.map((option) => option.id)).not.toContain('acme-hosted')
        expect(options.filter((option) => option.id === 'cloudflare')).toEqual([
            { id: 'cloudflare', name: 'Cloudflare' },
        ])
    })

    it('hides collapsed Cloudflare only when both model providers are hidden', () => {
        const baseProviders = {
            workers: {
                id: 'cloudflare-workers-ai',
                displayName: 'Cloudflare Workers AI',
                providerGroupId: 'cloudflare-workers-ai',
            },
            gateway: {
                id: 'cloudflare-ai-gateway',
                displayName: 'Cloudflare AI Gateway',
                providerGroupId: 'cloudflare-ai-gateway',
            },
        } as any

        const options = listApiKeyProviderOptions(
            baseProviders,
            new Set(['cloudflare-workers-ai', 'cloudflare-ai-gateway']),
        )

        expect(options.map((option) => option.id)).toEqual(['novelai', 'voyage'])
    })

    it('uses the first provider key as the default for a new preset', () => {
        const first = addApiKey({ name: 'first', key: 'k1', provider: 'openai' })
        addApiKey({ name: 'other provider', key: 'k2', provider: 'anthropic' })
        addApiKey({ name: 'second', key: 'k3', provider: 'openai' })

        expect(getDefaultApiKeyRef('openai')).toBe(first.id)
        expect(getDefaultApiKeyRef('missing')).toBeUndefined()
    })

    it('sorts legacy keys without order by updatedAt descending', () => {
        mockDb.db.apiKeyPool = {
            first: { id: 'first', name: 'first', key: 'k1', createdAt: 1, updatedAt: 1 },
            second: { id: 'second', name: 'second', key: 'k2', createdAt: 2, updatedAt: 2 },
        }
        clock = 3
        updateApiKey('first', { name: 'first!' })

        const names = listApiKeys().map((e) => e.name)

        expect(names[0]).toBe('first!')
        expect(names).toContain('second')
    })

    it('updates fields and bumps updatedAt without touching createdAt', () => {
        const entry = addApiKey({ name: 'old', key: 'k', provider: 'openai' })
        updateApiKey(entry.id, { name: 'new', provider: 'anthropic' })
        const after = getApiKey(entry.id)!
        expect(after.name).toBe('new')
        expect(after.provider).toBe('anthropic')
        expect(after.key).toBe('k')
        expect(after.createdAt).toBe(entry.createdAt)
        expect(after.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt)
    })

    it('update is a no-op for an unknown id', () => {
        addApiKey({ name: 'a', key: 'k' })
        const before = mockDb.db.apiKeyPool
        updateApiKey('missing', { name: 'x' })
        expect(mockDb.db.apiKeyPool).toBe(before)
    })

    it('removes a key', () => {
        const entry = addApiKey({ name: 'a', key: 'k' })
        removeApiKey(entry.id)
        expect(getApiKey(entry.id)).toBeUndefined()
        expect(Object.keys(mockDb.db.apiKeyPool)).toHaveLength(0)
    })
})

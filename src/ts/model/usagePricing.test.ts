import { describe, expect, it } from 'vitest'
import type { ModelsDevCatalog } from '../preset/registry/modelsDev'
import { estimateModelsDevUsageCost, findModelsDevCost } from './usagePricing'

const catalog: ModelsDevCatalog = {
    openai: {
        id: 'openai',
        name: 'OpenAI',
        npm: '@ai-sdk/openai',
        api: 'https://api.openai.com/v1',
        models: {
            demo: {
                id: 'demo',
                name: 'Demo',
                cost: {
                    input: 2,
                    output: 10,
                    cache_read: 0.2,
                    cache_write: 2.5,
                    reasoning: 12,
                    tiers: [{
                        input: 4,
                        output: 15,
                        cache_read: 0.4,
                        cache_write: 5,
                        reasoning: 18,
                        tier: { type: 'context', size: 200_000 },
                    }],
                },
            },
        },
    },
}

describe('models.dev usage pricing', () => {
    it('finds exact provider/model pricing and API-host fallbacks', () => {
        expect(findModelsDevCost(catalog, 'openai', 'demo')?.input).toBe(2)
        expect(findModelsDevCost(catalog, 'api.openai.com', 'DEMO')?.output).toBe(10)
    })

    it('prices uncached, cached, cache-write, visible output, and reasoning tokens', () => {
        const value = estimateModelsDevUsageCost(catalog, {
            provider: 'openai',
            model: 'demo',
            promptTokens: 1_000,
            cachedTokens: 200,
            cacheCreationTokens: 100,
            completionTokens: 500,
            reasoningTokens: 100,
        })

        expect(value).toBeCloseTo(
            (700 * 2 + 200 * 0.2 + 100 * 2.5 + 400 * 10 + 100 * 12) / 1_000_000,
        )
    })

    it.each(['flex', 'batch'])('applies the %s 50% discount', (serviceTier) => {
        const standard = estimateModelsDevUsageCost(catalog, {
            provider: 'openai',
            model: 'demo',
            promptTokens: 1_000,
            completionTokens: 500,
        })
        const discounted = estimateModelsDevUsageCost(catalog, {
            provider: 'openai',
            model: 'demo',
            promptTokens: 1_000,
            completionTokens: 500,
            serviceTier,
        })

        expect(discounted).toBe((standard ?? 0) / 2)
    })

    it('uses context tiers and keeps provider-reported gateway cost authoritative', () => {
        expect(estimateModelsDevUsageCost(catalog, {
            provider: 'openai',
            model: 'demo',
            promptTokens: 200_001,
            completionTokens: 1,
        })).toBeCloseTo((200_001 * 4 + 15) / 1_000_000)

        expect(estimateModelsDevUsageCost(catalog, {
            provider: 'openai',
            model: 'demo',
            promptTokens: 1_000,
            completionTokens: 500,
            serviceTier: 'flex',
            gatewayCost: 0.123,
        })).toBe(0.123)
    })
})

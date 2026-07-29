import type {
    ModelsDevBaseCost,
    ModelsDevCatalog,
    ModelsDevCost,
    ModelsDevProvider,
} from '../preset/registry/modelsDev'

export interface UsagePricingInput {
    provider?: string
    model?: string
    promptTokens?: number
    completionTokens?: number
    cachedTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    reasoningTokens?: number
    serviceTier?: string
    gatewayCost?: number
}

function tokens(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.round(value))
        : 0
}

function finiteCost(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : undefined
}

function providerByApiHost(
    catalog: ModelsDevCatalog,
    provider: string,
): ModelsDevProvider | undefined {
    const normalized = provider.toLowerCase()
    return Object.values(catalog).find((candidate) => {
        if (!candidate.api) return false
        try {
            return new URL(candidate.api).hostname.toLowerCase() === normalized
        } catch {
            return false
        }
    })
}

export function findModelsDevCost(
    catalog: ModelsDevCatalog | undefined,
    providerId: string | undefined,
    modelId: string | undefined,
): ModelsDevCost | undefined {
    if (!catalog || !providerId || !modelId) return undefined

    const normalizedProvider = providerId.toLowerCase()
    const provider = catalog[normalizedProvider]
        ?? providerByApiHost(catalog, normalizedProvider)
    if (!provider) return undefined

    const exact = provider.models[modelId]?.cost
    if (exact) return exact

    const normalizedModel = modelId.toLowerCase()
    return Object.values(provider.models)
        .find((model) => model.id.toLowerCase() === normalizedModel)
        ?.cost
}

function selectContextCost(cost: ModelsDevCost, promptTokens: number): ModelsDevBaseCost {
    let selected: ModelsDevBaseCost = cost
    let selectedThreshold = -1

    for (const tier of cost.tiers ?? []) {
        const threshold = tier.tier?.size
        if (Number.isFinite(threshold)
            && promptTokens > threshold
            && threshold > selectedThreshold) {
            selected = tier
            selectedThreshold = threshold
        }
    }

    if (selectedThreshold < 0 && promptTokens > 200_000 && cost.context_over_200k) {
        selected = cost.context_over_200k
    }
    return selected
}

function isHalfPriceTier(serviceTier: string | undefined): boolean {
    const normalized = serviceTier?.trim().toLowerCase()
    return normalized === 'flex' || normalized === 'batch'
}

export function estimateModelsDevUsageCost(
    catalog: ModelsDevCatalog | undefined,
    usage: UsagePricingInput,
): number | undefined {
    const gatewayCost = finiteCost(usage.gatewayCost)
    if (gatewayCost !== undefined) return gatewayCost

    const cost = findModelsDevCost(catalog, usage.provider, usage.model)
    if (!cost) return undefined

    const promptTokens = tokens(usage.promptTokens)
    const completionTokens = tokens(usage.completionTokens)
    const reasoningTokens = Math.min(completionTokens, tokens(usage.reasoningTokens))
    const cachedReadTokens = Math.min(
        promptTokens,
        tokens(usage.cachedTokens) + tokens(usage.cacheReadTokens),
    )
    const cacheWriteTokens = Math.min(
        promptTokens - cachedReadTokens,
        tokens(usage.cacheCreationTokens),
    )
    const uncachedTokens = promptTokens - cachedReadTokens - cacheWriteTokens
    const rates = selectContextCost(cost, promptTokens)
    const inputRate = finiteCost(rates.input)
    const outputRate = finiteCost(rates.output)
    if (inputRate === undefined || outputRate === undefined) return undefined
    const cacheReadRate = finiteCost(rates.cache_read) ?? inputRate
    const cacheWriteRate = finiteCost(rates.cache_write) ?? inputRate
    const reasoningRate = finiteCost(rates.reasoning) ?? outputRate

    const outputTokens = rates.reasoning === undefined
        ? completionTokens
        : completionTokens - reasoningTokens
    const costPerMillion = (
        uncachedTokens * inputRate
        + cachedReadTokens * cacheReadRate
        + cacheWriteTokens * cacheWriteRate
        + outputTokens * outputRate
        + reasoningTokens * reasoningRate
    )
    const discount = isHalfPriceTier(usage.serviceTier) ? 0.5 : 1
    return costPerMillion * discount / 1_000_000
}

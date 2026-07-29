import type {
    AuthKind,
    BaseProviderDefinition,
    EndpointKind,
    ModelProfile,
    RegistryCapability,
    RegistryCache,
} from '../types'
import recipeFile from './recipes/models-dev.json'
import { CLOUDFLARE_GATEWAY_ID_HEADER } from '../adapter/cloudflareEndpoint'
import {
    buildProtocolProfile,
    type ProfileProtocol,
} from '../profile/protocolDefinitions'

export const MODELS_DEV_REGISTRY_ID = 'models-dev'
export const MODELS_DEV_API_URL = 'https://models.dev/api.json'

interface WireRecipe {
    protocol?: ProfileProtocol
    auth?: AuthKind
    endpointKind?: EndpointKind
    displayName?: string
    api?: string
    path?: string
    baseProviderId?: string
    credentialKey?: string
    credentialLabel?: string
    cloudflareGateway?: boolean
    lockProviderWire?: boolean
    modelProviderPackages?: string[]
    headers?: Record<string, string>
    sourceUrls?: string[]
}

interface RecipeFile {
    schemaVersion: number
    packages: Record<string, WireRecipe>
    providers: Record<string, WireRecipe>
}

export interface ModelsDevProvider {
    id: string
    name: string
    npm: string
    env?: string[]
    api?: string
    doc?: string
    models: Record<string, ModelsDevModel>
}

export interface ModelsDevBaseCost {
    input: number
    output: number
    reasoning?: number
    cache_read?: number
    cache_write?: number
    input_audio?: number
    output_audio?: number
}

export interface ModelsDevCostTier extends ModelsDevBaseCost {
    tier: {
        type: 'context'
        size: number
    }
}

export interface ModelsDevCost extends ModelsDevBaseCost {
    context_over_200k?: ModelsDevBaseCost
    tiers?: ModelsDevCostTier[]
}

export interface ModelsDevModel {
    id: string
    name: string
    description?: string
    family?: string
    attachment?: boolean
    reasoning?: boolean
    tool_call?: boolean
    structured_output?: boolean
    temperature?: boolean
    release_date?: string
    last_updated?: string
    knowledge?: string
    status?: 'alpha' | 'beta' | 'deprecated'
    modalities?: {
        input?: string[]
        output?: string[]
    }
    limit?: {
        context?: number
        input?: number
        output?: number
    }
    cost?: ModelsDevCost
    reasoning_options?: Array<
        | { type: 'effort'; values: string[] }
        | { type: 'budget_tokens'; min?: number; max?: number }
        | { type: 'toggle' }
    >
    provider?: {
        npm?: string
        api?: string
        shape?: 'responses' | 'completions'
        body?: Record<string, unknown>
        headers?: Record<string, string>
    }
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>

interface EffectiveRecipe extends WireRecipe {
    protocol: ProfileProtocol
    auth: AuthKind
}

const recipes = recipeFile as RecipeFile
const DEFAULT_SOURCE = 'https://github.com/anomalyco/models.dev'
const EXCLUDED_PROVIDER_IDS = new Set(['github-copilot'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validateModelsDevCatalog(value: unknown): value is ModelsDevCatalog {
    if (!isPlainObject(value) || Object.keys(value).length === 0) return false
    for (const [providerId, raw] of Object.entries(value)) {
        if (!isPlainObject(raw)) return false
        if (raw.id !== providerId || typeof raw.name !== 'string' || typeof raw.npm !== 'string') return false
        if (!isPlainObject(raw.models)) return false
    }
    return true
}

export function buildModelsDevRegistry(catalog: ModelsDevCatalog, fetchedAt = Date.now()): RegistryCache {
    const baseProviders: Record<string, BaseProviderDefinition> = {}
    const profiles: Record<string, ModelProfile> = {}

    for (const provider of Object.values(catalog)) {
        // Private account integrations are not distributable providers. Keep
        // this explicit guard even without a provider recipe: models.dev may
        // otherwise rebuild them through a generic package fallback.
        if (EXCLUDED_PROVIDER_IDS.has(provider.id)) continue
        for (const model of Object.values(provider.models)) {
            const built = buildProfile(provider, model)
            if (!built) continue
            baseProviders[built.base.id] ??= built.base
            profiles[built.profile.id] = built.profile
        }
    }

    return {
        schemaVersion: 4,
        registries: {
            [MODELS_DEV_REGISTRY_ID]: {
                fetchedAt,
                source: MODELS_DEV_API_URL,
                baseProviders,
                profiles,
            },
        },
    }
}

function buildProfile(
    provider: ModelsDevProvider,
    model: ModelsDevModel,
): { base: BaseProviderDefinition; profile: ModelProfile } | undefined {
    if (!supportsPresetModel(provider, model)) return undefined

    const resolvedRecipe = resolveRecipe(provider, model)
    if (!resolvedRecipe) return undefined
    const effective: EffectiveRecipe = isDirectOpenAiImageModel(provider.id, model)
        ? { ...resolvedRecipe, protocol: 'openai-chat', path: 'images/generations' }
        : resolvedRecipe

    const endpoint = buildEndpoint(effective, provider, model)
    if (!endpoint) return undefined

    const endpointKind = endpointKindFor(effective)
    const baseId = baseIdFor(provider.id, effective)
    const credentialKey = effective.credentialKey
        ?? (effective.auth === 'google-service-account' ? 'serviceAccountJson' : 'apiKey')
    const displayName = effective.displayName ?? provider.name
    const sourceUrls = uniqueUrls([
        provider.doc,
        ...(effective.sourceUrls ?? []),
        DEFAULT_SOURCE,
    ])
    const capabilities = capabilitiesFor(model)
    const protocolProfile = buildProtocolProfile(
        effective.protocol,
        {
            authKind: effective.auth,
            endpointKind,
            credentialKey,
            credentialLabel: effective.credentialLabel,
        },
        {
            providerId: provider.id,
            modelId: model.id,
            family: model.family,
            reasoning: Boolean(model.reasoning),
            supportsTemperature: model.temperature !== false,
            maxOutputTokens: positive(model.limit?.output),
            reasoningEfforts: reasoningEfforts(model),
            inputModalities: model.modalities?.input ?? [],
            outputModalities: model.modalities?.output ?? [],
        },
    )
    const updatedAt = Math.max(
        parseDate(model.last_updated) ?? 0,
        protocolProfile.updatedAt,
    )
    const profileId = `${provider.id}:${model.id}`

    return {
        base: {
            id: baseId,
            displayName,
            providerGroupId: provider.id,
            providerGroupDisplayName: displayName,
            adapterKind: protocolProfile.adapterKind,
            authKinds: [effective.auth],
            endpointKinds: [endpointKind],
            defaultHeaders: {
                'Content-Type': 'application/json',
                ...protocolProfile.defaultHeaders,
                ...(effective.cloudflareGateway ? { [CLOUDFLARE_GATEWAY_ID_HEADER]: 'default' } : {}),
                ...(effective.headers ?? {}),
            },
            defaultBody: {},
            requestSchema: protocolProfile.requestSchema,
            uiSchema: protocolProfile.requestUiSchema,
            capabilities,
            sourceUrls,
        },
        profile: {
            id: profileId,
            updatedAt,
            displayName: model.name,
            providerBaseId: baseId,
            profileStatus: model.status === 'deprecated' ? 'deprecated' : 'current',
            statusReason: model.status && model.status !== 'deprecated'
                ? `models.dev status: ${model.status}`
                : undefined,
            description: descriptionFor(model),
            modelReleaseDate: model.release_date,
            knowledgeCutoff: model.knowledge,
            tags: uniqueStrings([
                provider.id,
                model.family,
                model.status,
                effective.protocol,
                'models.dev',
            ]),
            modelId: protocolProfile.modelId,
            endpoint,
            auth: {
                kind: effective.auth,
                fields: effective.auth === 'none' ? [] : [credentialKey],
            },
            defaults: {},
            schema: protocolProfile.schema,
            uiSchema: protocolProfile.uiSchema,
            bodyTemplate: model.provider?.body,
            headerTemplate: model.provider?.headers,
            capabilities,
            limits: {
                known: isPositive(model.limit?.context) || isPositive(model.limit?.output),
                contextWindowTokens: positive(model.limit?.context),
                maxOutputTokens: positive(model.limit?.output),
                sourceUrls,
            },
            sourceUrls,
        },
    }
}

function resolveRecipe(provider: ModelsDevProvider, model: ModelsDevModel): EffectiveRecipe | undefined {
    const npm = model.provider?.npm ?? provider.npm
    const fromPackage = recipes.packages[npm] ?? {}
    const providerRecipe = recipes.providers[provider.id]
    // A per-model SDK override means the model uses a different wire protocol
    // than its provider default (for example Claude/OpenAI routes through
    // Google Vertex). An explicit provider recipe describes only that default
    // wire, so do not guess at the alternate route.
    const providerRecipeDefinesWire = providerRecipe !== undefined && (
        providerRecipe.protocol !== undefined
        || providerRecipe.auth !== undefined
        || providerRecipe.api !== undefined
        || providerRecipe.path !== undefined
        || providerRecipe.endpointKind !== undefined
    )
    const modelPackageOverride = model.provider?.npm
        && model.provider.npm !== provider.npm
        ? model.provider.npm
        : undefined
    const allowedModelPackage = modelPackageOverride !== undefined
        && providerRecipe?.modelProviderPackages?.includes(modelPackageOverride) === true
    if (
        providerRecipeDefinesWire
        && modelPackageOverride
        && !providerRecipe.lockProviderWire
        && !allowedModelPackage
    ) {
        return undefined
    }
    const fromProvider = providerRecipe ?? {}
    const merged: WireRecipe = allowedModelPackage
        ? { ...fromProvider, ...fromPackage }
        : { ...fromPackage, ...fromProvider }

    if (!merged.lockProviderWire && model.provider?.shape === 'responses') {
        merged.protocol = 'openai-responses'
        merged.path = 'responses'
    } else if (
        !merged.lockProviderWire
        && model.provider?.shape === 'completions'
        && merged.protocol === 'openai-responses'
    ) {
        merged.protocol = 'openai-chat'
        merged.path = 'chat/completions'
    }

    if (!merged.protocol || !merged.auth) return undefined
    return merged as EffectiveRecipe
}

function buildEndpoint(
    recipe: EffectiveRecipe,
    provider: ModelsDevProvider,
    model: ModelsDevModel,
): ModelProfile['endpoint'] | undefined {
    if (recipe.protocol === 'vertex-gemini') return { kind: 'vertex-gemini' }
    if (recipe.endpointKind === 'cloudflare-ai') return { kind: 'cloudflare-ai' }
    if (recipe.endpointKind === 'amazon-bedrock') return { kind: 'amazon-bedrock' }
    if (recipe.endpointKind === 'amazon-bedrock-mantle') {
        return {
            kind: 'amazon-bedrock-mantle',
            path: bedrockMantlePath(model.provider?.api, recipe.path),
        }
    }

    const api = recipe.lockProviderWire
        ? recipe.api ?? provider.api
        : model.provider?.api ?? provider.api ?? recipe.api
    if (!api || !safeRemoteBase(api)) return undefined
    return {
        kind: 'static',
        url: appendPath(api, recipe.path),
    }
}

function supportsPresetModel(provider: ModelsDevProvider, model: ModelsDevModel): boolean {
    const input = model.modalities?.input
    const output = model.modalities?.output
    if (!Array.isArray(input) || !input.includes('text') || !Array.isArray(output)) {
        return false
    }
    if (output.includes('text')) return true
    if (provider.id === 'google' && (output.includes('image') || output.includes('audio'))) {
        return true
    }
    return isDirectOpenAiImageModel(provider.id, model)
}

function isDirectOpenAiImageModel(providerId: string, model: ModelsDevModel): boolean {
    return providerId === 'openai'
        && model.family?.toLowerCase() === 'gpt-image'
        && model.modalities?.output?.includes('image') === true
}

function safeRemoteBase(value: string): boolean {
    if (value.includes('${') || value.includes('{env:')) return false
    try {
        return new URL(value).protocol === 'https:'
    } catch {
        return false
    }
}

function appendPath(base: string, suffix?: string): string {
    const cleanBase = base.replace(/\/+$/, '')
    const cleanSuffix = suffix?.replace(/^\/+|\/+$/g, '')
    if (!cleanSuffix || cleanBase.endsWith(`/${cleanSuffix}`)) return cleanBase
    return `${cleanBase}/${cleanSuffix}`
}

function bedrockMantlePath(api: string | undefined, suffix?: string): string {
    const prefix = api?.match(/api\.aws\/([^$?]+)/u)?.[1]?.replace(/^\/+|\/+$/gu, '')
        ?? 'v1'
    return appendPath(prefix, suffix)
}

function baseIdFor(providerId: string, recipe: EffectiveRecipe): string {
    if (recipe.baseProviderId) {
        return recipe.protocol === 'openai-responses'
            ? `${recipe.baseProviderId}--responses`
            : recipe.baseProviderId
    }
    return recipe.protocol === 'openai-responses'
        ? `${providerId}--responses`
        : providerId
}

function endpointKindFor(recipe: EffectiveRecipe): EndpointKind {
    if (recipe.endpointKind) return recipe.endpointKind
    return recipe.protocol === 'vertex-gemini' ? 'vertex-gemini' : 'static'
}

function reasoningEfforts(model: ModelsDevModel): string[] {
    const values = model.reasoning_options
        ?.find((option) => option?.type === 'effort')
        ?.values
    return Array.isArray(values)
        ? uniqueStrings(values.filter((value): value is string => typeof value === 'string'))
        : []
}

function capabilitiesFor(model: ModelsDevModel): RegistryCapability[] {
    const capabilities: RegistryCapability[] = ['streaming']
    if (model.modalities?.input?.includes('image') || model.attachment) capabilities.push('vision')
    if (model.modalities?.output?.includes('image')) capabilities.push('image-output')
    if (model.tool_call) capabilities.push('tools')
    if (model.structured_output) capabilities.push('json')
    if (model.reasoning) capabilities.push('reasoning')
    return capabilities
}

function descriptionFor(model: ModelsDevModel): string {
    return [
        model.description ? `${model.description.replace(/[.\s]+$/, '')}.` : undefined,
        model.family ? `Family: ${model.family}.` : undefined,
        'Model metadata supplied by models.dev.',
    ].filter(Boolean).join(' ')
}

function parseDate(value?: string): number | undefined {
    if (!value) return undefined
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
}

function positive(value: unknown): number | undefined {
    return isPositive(value) ? value : undefined
}

function isPositive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function uniqueStrings(values: Array<string | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => !!value))]
}

function uniqueUrls(values: Array<string | undefined>): string[] {
    return uniqueStrings(values).filter((value) => {
        try {
            return new URL(value).protocol === 'https:'
        } catch {
            return false
        }
    })
}

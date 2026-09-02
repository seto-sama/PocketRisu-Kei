import { describe, expect, test } from 'vitest'
import { resolveSnapshot } from './snapshot'
import {
    buildModelsDevRegistry,
    MODELS_DEV_REGISTRY_ID,
    type ModelsDevCatalog,
    validateModelsDevCatalog,
} from './modelsDev'

function provider(overrides: Partial<ModelsDevCatalog[string]> = {}): ModelsDevCatalog[string] {
    return {
        id: 'demo',
        name: 'Demo Provider',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://api.demo.test/v1',
        env: ['DEMO_API_KEY'],
        doc: 'https://docs.demo.test/models',
        models: {},
        ...overrides,
    }
}

function model(overrides: Record<string, unknown> = {}) {
    return {
        id: 'chat',
        name: 'Chat',
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        tool_call: true,
        structured_output: true,
        temperature: true,
        release_date: '2026-01-01',
        last_updated: '2026-06-02',
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 128000, output: 16384 },
        ...overrides,
    }
}

describe('buildModelsDevRegistry', () => {
    function buildDemoSnapshot() {
        const registry = buildModelsDevRegistry({
            demo: provider({ models: { chat: model() } as any }),
        })
        return { registry, snapshot: resolveSnapshot(registry, 'demo:chat') }
    }

    test('routes an OpenAI-compatible model with bearer authentication', () => {
        const { registry, snapshot } = buildDemoSnapshot()

        expect(registry.registries).toHaveProperty(MODELS_DEV_REGISTRY_ID)
        expect(snapshot).toMatchObject({
            adapterKind: 'openai-compatible',
            endpoint: { url: 'https://api.demo.test/v1/chat/completions' },
            auth: { kind: 'bearer', fields: ['apiKey'] },
            modelId: 'chat',
        })
        expect(snapshot.uiSchema.fields.filter(field => field.key === 'apiKey')).toHaveLength(1)
        expect(snapshot.schema.some(field => field.key === 'modelId')).toBe(false)
    })

    test('maps model capabilities and published token limits', () => {
        const { snapshot } = buildDemoSnapshot()

        expect(snapshot.capabilities).toEqual(
            expect.arrayContaining(['streaming', 'vision', 'tools', 'json', 'reasoning']),
        )
        expect(snapshot.limits).toMatchObject({
            known: true,
            contextWindowTokens: 128000,
            maxOutputTokens: 16384,
        })
        expect(snapshot.schema.find(field => field.key === 'max_tokens')).toMatchObject({
            max: 16384,
            mapsTo: { target: 'body', path: 'max_tokens' },
        })
    })

    test('exposes supported generation controls once', () => {
        const { snapshot } = buildDemoSnapshot()
        const uiByKey = new Map(snapshot.uiSchema.fields.map(field => [field.key, field]))

        expect(uiByKey.get('apiKey')).toMatchObject({
            widget: 'secret', visibility: 'info', group: 'credentials',
        })
        const reasoning = snapshot.schema.find(field => field.key === 'reasoning_effort')
        expect(reasoning).toMatchObject({
            labelKey: 'reasoningEffort',
            helpKey: 'reasoningEffort',
        })
        expect(reasoning?.enum?.map(option => option.value)).toEqual(['low', 'high'])
        expect(uiByKey.get('max_tokens')).toMatchObject({
            widget: 'slider', visibility: 'basic', disableable: true, group: 'generation',
        })
        expect(uiByKey.get('temperature')).toMatchObject({
            widget: 'slider', disableable: true, group: 'generation',
        })
    })

    test('keeps release metadata out of the human description', () => {
        const { registry } = buildDemoSnapshot()
        const profile = registry.registries[MODELS_DEV_REGISTRY_ID]?.profiles?.['demo:chat']

        expect(profile).toMatchObject({ modelReleaseDate: '2026-01-01' })
        expect(profile?.description).not.toContain('Released:')
        expect(profile?.description).not.toContain('Knowledge cutoff:')
    })

    test.each([
        {
            providerId: 'anthropic',
            npm: '@ai-sdk/anthropic',
            modelId: 'claude-sonnet',
            family: 'claude',
            reasoningKey: 'effort',
            reasoningPath: 'output_config.effort',
        },
        {
            providerId: 'google',
            npm: '@ai-sdk/google',
            modelId: 'gemini-pro',
            family: 'gemini',
            reasoningKey: 'thinkingLevel',
            reasoningPath: 'generationConfig.thinkingConfig.thinkingLevel',
        },
    ] as const)('adds token-budget reasoning controls to $providerId profiles', (fixture) => {
        const entry = provider({
            id: fixture.providerId,
            npm: fixture.npm,
            models: {
                [fixture.modelId]: model({ id: fixture.modelId, family: fixture.family }),
            } as any,
        })
        const snapshot = resolveSnapshot(
            buildModelsDevRegistry({ [fixture.providerId]: entry }),
            `${fixture.providerId}:${fixture.modelId}`,
        )
        const reasoning = snapshot.schema.find(field => field.key === fixture.reasoningKey)

        expect(reasoning?.enum?.map(option => option.value)).toEqual(['low', 'high', 'budget'])
        expect(reasoning?.mapsTo).toEqual({ target: 'body', path: fixture.reasoningPath })
        expect(snapshot.schema.find(field => field.key === 'thinking_tokens')).toMatchObject({
            type: 'integer',
            default: 1024,
            min: 1024,
        })
        expect(snapshot.uiSchema.fields.find(field => field.key === 'thinking_tokens'))
            .toMatchObject({
                widget: 'number-input',
                visibility: 'basic',
                group: 'connection',
                showIf: { key: fixture.reasoningKey, equals: 'budget' },
            })
    })

    test('maps Gemini output limits into generationConfig', () => {
        const google = provider({
            id: 'google',
            npm: '@ai-sdk/google',
            models: { 'gemini-pro': model({ id: 'gemini-pro', family: 'gemini' }) } as any,
        })
        const snapshot = resolveSnapshot(
            buildModelsDevRegistry({ google }),
            'google:gemini-pro',
        )

        expect(snapshot.schema.find(field => field.key === 'maxOutputTokens')?.mapsTo)
            .toEqual({ target: 'body', path: 'generationConfig.maxOutputTokens' })
    })

    test.each([
        {
            providerId: 'openai',
            npm: '@ai-sdk/openai',
            modelId: 'gpt-5.6',
            family: 'gpt',
            tiers: ['auto', 'default', 'flex', 'priority'],
        },
        {
            providerId: 'google',
            npm: '@ai-sdk/google',
            modelId: 'gemini-3.6-flash',
            family: 'gemini',
            tiers: ['flex', 'priority'],
        },
    ] as const)('exposes first-party service tiers on $providerId profiles', (fixture) => {
        const entry = provider({
            id: fixture.providerId,
            npm: fixture.npm,
            models: {
                [fixture.modelId]: model({ id: fixture.modelId, family: fixture.family }),
            } as any,
        })
        const snapshot = resolveSnapshot(
            buildModelsDevRegistry({ [fixture.providerId]: entry }),
            `${fixture.providerId}:${fixture.modelId}`,
        )
        const serviceTier = snapshot.schema.find(field => field.key === 'service_tier')

        expect(serviceTier).toMatchObject({
            labelKey: 'modelPresetServiceTier',
            helpKey: 'modelPresetServiceTierHelp',
            mapsTo: { target: 'body', path: 'service_tier' },
        })
        expect(serviceTier?.enum?.map(option => option.value)).toEqual(fixture.tiers)
        expect(snapshot.uiSchema.fields.find(field => field.key === 'service_tier'))
            .toMatchObject({
                widget: 'select',
                visibility: 'basic',
                layout: 'row',
                group: 'connection',
            })
    })

    test('maps Vertex service tiers to its shared-request header only', () => {
        const compatible = buildDemoSnapshot().snapshot
        const vertex = provider({
            id: 'google-vertex',
            npm: '@ai-sdk/google-vertex',
            api: undefined,
            models: {
                'google/gemini-3.6-flash': model({
                    id: 'google/gemini-3.6-flash',
                    family: 'gemini',
                }),
            } as any,
        })
        const vertexSnapshot = resolveSnapshot(
            buildModelsDevRegistry({ 'google-vertex': vertex }),
            'google-vertex:google/gemini-3.6-flash',
        )

        expect(compatible.schema.some(field => field.key === 'service_tier')).toBe(false)
        expect(vertexSnapshot.schema.find(field => field.key === 'service_tier')).toMatchObject({
            enum: [
                { value: 'flex', label: 'Flex' },
                { value: 'priority', label: 'Priority' },
            ],
            mapsTo: {
                target: 'header',
                path: 'X-Vertex-AI-LLM-Shared-Request-Type',
            },
        })
    })

    test('adds opt-in thinking input/output flags to DeepSeek provider profiles', () => {
        const deepseek = provider({
            id: 'deepseek',
            name: 'DeepSeek',
            npm: '@ai-sdk/openai-compatible',
            models: {
                'opaque-reasoner': model({
                    id: 'opaque-reasoner',
                }),
            } as any,
        })
        const snapshot = resolveSnapshot(
            buildModelsDevRegistry({ deepseek }),
            'deepseek:opaque-reasoner',
        )

        expect([
            'customFlag_deepSeekThinkingInput',
            'customFlag_deepSeekThinkingOutput',
        ].map((key) => snapshot.schema.find((field) => field.key === key)?.default))
            .toEqual([false, false])
        expect(snapshot.uiSchema.groups.find((group) => group.id === 'flags'))
            .toMatchObject({ labelKey: 'modelPresetCustomFlagsGroup', order: 4 })
        expect([
            'customFlag_deepSeekThinkingInput',
            'customFlag_deepSeekThinkingOutput',
        ].map((key) => snapshot.uiSchema.fields.find((field) => field.key === key)))
            .toEqual([
                expect.objectContaining({ widget: 'toggle', visibility: 'advanced', order: 1 }),
                expect.objectContaining({ widget: 'toggle', visibility: 'advanced', order: 2 }),
            ])
    })

    test('does not add DeepSeek flags to another reasoning provider', () => {
        const reasoningProvider = provider({
            id: 'reasoning-provider',
            name: 'Reasoning Provider',
            npm: '@ai-sdk/openai-compatible',
            models: {
                reasoner: model({ id: 'reasoner', reasoning: true }),
            } as any,
        })
        const snapshot = resolveSnapshot(
            buildModelsDevRegistry({ 'reasoning-provider': reasoningProvider }),
            'reasoning-provider:reasoner',
        )

        expect(snapshot.schema.some(
            (field) => field.key === 'customFlag_deepSeekThinkingInput'
                || field.key === 'customFlag_deepSeekThinkingOutput',
        )).toBe(false)
        expect(snapshot.uiSchema.groups.some((group) => group.id === 'flags')).toBe(false)
    })

    test('makes Gemini image output fixed while keeping optional media flags', () => {
        const google = provider({
            id: 'google',
            name: 'Google',
            npm: '@ai-sdk/google',
            models: {
                media: model({
                    id: 'gemini-media',
                    modalities: {
                        input: ['text', 'image', 'audio', 'video'],
                        output: ['text', 'image', 'audio'],
                    },
                }),
            } as any,
        })
        const snapshot = resolveSnapshot(
            buildModelsDevRegistry({ google }),
            'google:gemini-media',
        )

        expect([
            'customFlag_hasAudioInput',
            'customFlag_hasAudioOutput',
            'customFlag_hasVideoInput',
        ].map((key) => snapshot.schema.find((field) => field.key === key)?.default))
            .toEqual([false, false, false])
        expect(snapshot.schema.some(
            (field) => field.key === 'customFlag_hasImageOutput',
        )).toBe(false)
        expect(snapshot.capabilities).toContain('image-output')
    })

    test('registers direct GPT Image models on the Images API with image output', () => {
        const openai = provider({
            id: 'openai',
            name: 'OpenAI',
            npm: '@ai-sdk/openai',
            api: undefined,
            models: {
                image: model({
                    id: 'gpt-image-2',
                    family: 'gpt-image',
                    modalities: { input: ['text', 'image'], output: ['image'] },
                }),
            } as any,
        })
        const snapshot = resolveSnapshot(
            buildModelsDevRegistry({ openai }),
            'openai:gpt-image-2',
        )

        expect(snapshot.endpoint.url).toBe('https://api.openai.com/v1/images/generations')
        expect(snapshot.schema.some(
            (field) => field.key === 'customFlag_hasImageOutput',
        )).toBe(false)
        expect(snapshot.capabilities).toContain('image-output')
    })

    test('adds only the output flag when another provider serves a DeepSeek family model', () => {
        const hosted = provider({
            id: 'hosted-models',
            name: 'Hosted Models',
            npm: '@ai-sdk/openai-compatible',
            models: {
                reasoner: model({
                    id: 'opaque-reasoner',
                    family: 'deepseek',
                    reasoning: true,
                }),
            } as any,
        })
        const snapshot = resolveSnapshot(
            buildModelsDevRegistry({ 'hosted-models': hosted }),
            'hosted-models:opaque-reasoner',
        )

        expect(snapshot.schema.some(
            (field) => field.key === 'customFlag_deepSeekThinkingInput',
        )).toBe(false)
        expect(snapshot.schema.find(
            (field) => field.key === 'customFlag_deepSeekThinkingOutput',
        )).toMatchObject({ type: 'boolean', default: false })
        expect(snapshot.uiSchema.groups.find((group) => group.id === 'flags'))
            .toMatchObject({ labelKey: 'modelPresetCustomFlagsGroup', order: 4 })
    })

    test('stores model release and knowledge dates as profile metadata', () => {
        const catalog = {
            demo: provider({
                models: {
                    chat: model({
                        description: 'A demo model.',
                        knowledge: '2025-12',
                    }),
                } as any,
            }),
        }
        const profile = buildModelsDevRegistry(catalog)
            .registries[MODELS_DEV_REGISTRY_ID]?.profiles?.['demo:chat']

        expect(profile).toMatchObject({
            modelReleaseDate: '2026-01-01',
            knowledgeCutoff: '2025-12',
        })
        expect(profile?.description).toBe('A demo model. Model metadata supplied by models.dev.')
    })

    function buildGatewayFamilySnapshots() {
        const gateway = provider({
            id: 'other-gateway',
            name: 'Other Gateway',
            models: {
                'openai/gpt-5': model({
                    id: 'openai/gpt-5',
                    name: 'GPT-5',
                    family: 'gpt',
                }),
                'anthropic/claude-sonnet': model({
                    id: 'anthropic/claude-sonnet',
                    name: 'Claude Sonnet',
                    family: 'claude',
                }),
            } as any,
        })
        const registry = buildModelsDevRegistry({ 'other-gateway': gateway })
        return {
            gpt: resolveSnapshot(registry, 'other-gateway:openai/gpt-5'),
            claude: resolveSnapshot(registry, 'other-gateway:anthropic/claude-sonnet'),
        }
    }

    test('adds a Completions/Responses selector only to GPT-family models', () => {
        const { gpt, claude } = buildGatewayFamilySnapshots()
        const mode = gpt.schema.find((field) => field.key === 'openaiApiMode')

        expect(mode).toMatchObject({
            default: 'completions',
            labelKey: 'modelPresetRequestFormat',
            helpKey: 'modelPresetRequestFormatHelp',
        })
        expect(mode?.enum?.map((option) => option.value)).toEqual(['completions', 'responses'])
        expect(gpt.uiSchema.fields.find((field) => field.key === 'openaiApiMode')).toMatchObject({
            widget: 'select',
            visibility: 'basic',
        })
        expect(claude.schema.some((field) => field.key === 'openaiApiMode')).toBe(false)
    })

    test('adds supported verbosity controls to GPT-family models', () => {
        const { gpt } = buildGatewayFamilySnapshots()

        expect(gpt.schema.find((field) => field.key === 'verbosity')?.enum?.map(option => option.value))
            .toEqual(['low', 'medium', 'high'])
        expect(gpt.schema.find((field) => field.key === 'verbosity'))
            .toMatchObject({ labelKey: 'verbosity', helpKey: 'verbosity' })
        expect(gpt.uiSchema.fields.find((field) => field.key === 'verbosity'))
            .toMatchObject({ visibility: 'basic', layout: 'row', group: 'connection' })
    })

    test('uses native Responses fields when a non-GPT route declares that shape', () => {
        const catalog = {
            demo: provider({
                models: {
                    chat: model({
                        family: 'custom',
                        provider: { shape: 'responses' },
                    }),
                } as any,
            }),
        }
        const snapshot = resolveSnapshot(buildModelsDevRegistry(catalog), 'demo:chat')

        expect(snapshot.adapterKind).toBe('openai-responses')
        expect(snapshot.endpoint.url).toBe('https://api.demo.test/v1/responses')
        expect(snapshot.schema.find((field) => field.key === 'max_output_tokens')?.mapsTo)
            .toEqual({ target: 'body', path: 'max_output_tokens' })
        expect(snapshot.schema.find((field) => field.key === 'reasoning_effort')?.mapsTo)
            .toEqual({ target: 'body', path: 'reasoning.effort' })
        expect(snapshot.schema.some((field) => field.key === 'openaiApiMode')).toBe(false)
    })

    test('offers explicit prompt caching with GPT-5.6 connection controls', () => {
        const openai = provider({
            id: 'openai',
            name: 'OpenAI',
            npm: '@ai-sdk/openai',
            api: 'https://api.openai.com/v1',
            models: {
                'gpt-5.6-sol': model({
                    id: 'gpt-5.6-sol',
                    name: 'GPT-5.6 Sol',
                    family: 'gpt',
                }),
            } as any,
        })
        const snapshot = resolveSnapshot(
            buildModelsDevRegistry({ openai }),
            'openai:gpt-5.6-sol',
        )

        expect(snapshot.schema.find(field => field.key === 'prompt_cache_mode')).toMatchObject({
            default: 'implicit',
            mapsTo: { target: 'body', path: 'prompt_cache_options.mode' },
        })
        expect(snapshot.uiSchema.fields.find(field => field.key === 'prompt_cache_mode'))
            .toMatchObject({ visibility: 'basic', layout: 'row', group: 'connection' })
    })

    test('excludes private providers before generic package fallback', () => {
        const privateProvider = provider({
            id: 'github-copilot',
            name: 'Private Provider',
            api: 'https://private-provider.example.test/v1',
            models: { 'gpt-5-mini': model({ id: 'gpt-5-mini', name: 'GPT-5 Mini' }) } as any,
        })
        const entry = buildModelsDevRegistry({ 'github-copilot': privateProvider })
            .registries[MODELS_DEV_REGISTRY_ID]

        expect(entry?.baseProviders).toEqual({})
        expect(entry?.profiles).toEqual({})
    })

    test('builds standard Vertex Gemini snapshots from the same catalog', () => {
        const vertex = provider({
            id: 'google-vertex',
            name: 'Google Vertex',
            npm: '@ai-sdk/google-vertex',
            api: undefined,
            models: {
                'google/gemini-2.5-pro': model({
                    id: 'google/gemini-2.5-pro',
                    name: 'Gemini 2.5 Pro',
                }),
            } as any,
        })
        const snapshot = resolveSnapshot(
            buildModelsDevRegistry({ 'google-vertex': vertex }),
            'google-vertex:google/gemini-2.5-pro',
        )

        expect(snapshot.adapterKind).toBe('google-gemini')
        expect(snapshot.endpoint.kind).toBe('vertex-gemini')
        expect(snapshot.auth.kind).toBe('google-service-account')
        expect(snapshot.modelId).toBe('gemini-2.5-pro')
        expect(snapshot.schema.find((field) => field.key === 'location')).toMatchObject({
            default: 'global',
            labelKey: 'location',
            helpKey: 'modelPresetLocationHelp',
        })
        expect(snapshot.schema.some((field) => field.key === 'projectId')).toBe(false)
        expect(snapshot.schema.some((field) => field.key === 'endpointUrl')).toBe(false)
    })

    test('uses user-facing product names for Google AI Studio and Google Vertex AI', () => {
        const google = provider({
            id: 'google',
            name: 'Google',
            npm: '@ai-sdk/google',
            api: undefined,
            models: { gemini: model({ id: 'gemini', name: 'Gemini' }) } as any,
        })
        const vertex = provider({
            id: 'google-vertex',
            name: 'Google Vertex',
            npm: '@ai-sdk/google-vertex',
            api: undefined,
            models: { 'google/gemini': model({ id: 'google/gemini', name: 'Gemini' }) } as any,
        })
        const entry = buildModelsDevRegistry({ google, 'google-vertex': vertex })
            .registries[MODELS_DEV_REGISTRY_ID]

        expect(entry?.baseProviders?.google?.displayName).toBe('Google AI Studio')
        expect(entry?.baseProviders?.['google-vertex']?.displayName).toBe('Google Vertex AI')
    })

    function buildBedrockSnapshots() {
        const bedrock = provider({
            id: 'amazon-bedrock',
            name: 'Amazon Bedrock',
            npm: '@ai-sdk/amazon-bedrock',
            api: undefined,
            models: {
                'amazon.nova-lite-v1:0': model({
                    id: 'amazon.nova-lite-v1:0',
                    name: 'Nova Lite',
                }),
                'global.anthropic.claude-sonnet': model({
                    id: 'global.anthropic.claude-sonnet',
                    name: 'Claude Sonnet',
                    provider: { npm: '@ai-sdk/anthropic' },
                }),
                'openai.gpt-5.6-sol': model({
                    id: 'openai.gpt-5.6-sol',
                    name: 'GPT-5.6 Sol',
                    family: 'gpt',
                    provider: {
                        npm: '@ai-sdk/amazon-bedrock/mantle',
                        api: 'https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1',
                        shape: 'responses',
                    },
                }),
            } as any,
        })
        const registry = buildModelsDevRegistry({ 'amazon-bedrock': bedrock })
        return {
            expectedProfileCount: Object.keys(bedrock.models).length,
            profileCount: Object.keys(
                registry.registries[MODELS_DEV_REGISTRY_ID]?.profiles ?? {},
            ).length,
            native: resolveSnapshot(registry, 'amazon-bedrock:global.anthropic.claude-sonnet'),
            mantle: resolveSnapshot(registry, 'amazon-bedrock:openai.gpt-5.6-sol'),
        }
    }

    test('builds native Amazon Bedrock Converse models with regional auth', () => {
        const { native, profileCount, expectedProfileCount } = buildBedrockSnapshots()

        expect(profileCount).toBe(expectedProfileCount)
        expect(native.adapterKind).toBe('amazon-bedrock')
        expect(native.endpoint).toEqual({ kind: 'amazon-bedrock' })
        expect(native.auth).toEqual({
            kind: 'aws-bedrock',
            fields: ['bedrockCredential'],
        })
        expect(native.schema.find((field) => field.key === 'bedrockRegion')).toMatchObject({
            default: 'us-east-1',
            required: true,
            mapsTo: { target: 'custom', path: 'bedrockRegion' },
        })
        expect(native.schema.find((field) => field.key === 'maxTokens'))
            .toMatchObject({
                semantic: 'maxOutputTokens',
                mapsTo: { target: 'body', path: 'inferenceConfig.maxTokens' },
            })
    })

    test('builds Amazon Bedrock Mantle models on the Responses wire format', () => {
        const { mantle } = buildBedrockSnapshots()

        expect(mantle.adapterKind).toBe('openai-responses')
        expect(mantle.endpoint).toEqual({
            kind: 'amazon-bedrock-mantle',
            path: 'openai/v1/responses',
        })
        expect(mantle.auth.kind).toBe('aws-bedrock')
        expect(mantle.schema.find((field) => field.key === 'bedrockRegion')?.default)
            .toBe('us-east-1')
        expect(mantle.schema.find((field) => field.key === 'openaiApiMode')?.default)
            .toBe('responses')
    })

    test('builds every Workers AI model on the Cloudflare account endpoint', () => {
        const workers = provider({
            id: 'cloudflare-workers-ai',
            name: 'Cloudflare Workers AI',
            npm: '@ai-sdk/openai-compatible',
            api: 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1',
            models: {
                '@cf/meta/llama': model({ id: '@cf/meta/llama', name: 'Llama' }),
                '@cf/openai/gpt-oss': model({
                    id: '@cf/openai/gpt-oss',
                    name: 'GPT OSS',
                    family: 'gpt',
                }),
            } as any,
        })
        const registry = buildModelsDevRegistry({ 'cloudflare-workers-ai': workers })
        const profiles = registry.registries[MODELS_DEV_REGISTRY_ID]?.profiles ?? {}
        const snapshot = resolveSnapshot(registry, 'cloudflare-workers-ai:@cf/meta/llama')

        expect(Object.keys(profiles)).toHaveLength(2)
        expect(snapshot.adapterKind).toBe('openai-compatible')
        expect(snapshot.endpoint).toEqual({
            kind: 'cloudflare-ai',
            path: 'chat/completions',
        })
        expect(snapshot.auth).toEqual({ kind: 'bearer', fields: ['cloudflareApiToken'] })
        expect(snapshot.schema.find((field) => field.key === 'cloudflareAccountId')).toMatchObject({
            helpKey: 'cloudflareAccountIdHelp',
            required: true,
            secret: true,
            mapsTo: { target: 'custom', path: 'cloudflareAccountId' },
        })
        expect(snapshot.uiSchema.fields.find((field) => field.key === 'cloudflareAccountId'))
            .toMatchObject({ widget: 'secret', visibility: 'basic' })
        expect(snapshot.schema.some((field) => field.key === 'cloudflareGatewayId')).toBe(false)
    })

    function buildCloudflareGatewaySnapshot(modelId: string) {
        const gateway = provider({
            id: 'cloudflare-ai-gateway',
            name: 'Cloudflare AI Gateway',
            npm: 'ai-gateway-provider',
            api: undefined,
            models: {
                'openai/gpt-5': model({
                    id: 'openai/gpt-5',
                    name: 'GPT-5',
                    family: 'gpt',
                }),
                'openai/gpt-5.6-sol': model({
                    id: 'openai/gpt-5.6-sol',
                    name: 'GPT-5.6 Sol',
                    family: 'gpt-sol',
                }),
                'anthropic/claude-opus-4-8': model({
                    id: 'anthropic/claude-opus-4-8',
                    name: 'Claude Opus 4.8',
                    family: 'claude-opus',
                    provider: {
                        npm: '@ai-sdk/anthropic',
                        api: 'https://api.anthropic.com/v1',
                    },
                }),
            } as any,
        })
        const registry = buildModelsDevRegistry({ 'cloudflare-ai-gateway': gateway })
        return resolveSnapshot(registry, `cloudflare-ai-gateway:${modelId}`)
    }

    test('routes Anthropic AI Gateway models through the Messages format', () => {
        const claude = buildCloudflareGatewaySnapshot('anthropic/claude-opus-4-8')

        expect(claude.adapterKind).toBe('anthropic-messages')
        expect(claude.endpoint).toEqual({ kind: 'cloudflare-ai', path: 'messages' })
        expect(claude.auth).toEqual({ kind: 'bearer', fields: ['cloudflareApiToken'] })
        expect(claude.modelId).toBe('anthropic/claude-opus-4-8')
        expect(claude.headerTemplate['anthropic-version']).toBe('2023-06-01')
        expect(claude.headerTemplate['cf-aig-gateway-id']).toBe('default')
        expect(claude.schema.some((field) => field.key === 'cloudflareGatewayId')).toBe(false)
        expect(claude.uiSchema.fields.some((field) => field.key === 'cloudflareGatewayId'))
            .toBe(false)
    })

    test.each(['openai/gpt-5', 'openai/gpt-5.6-sol'])(
        'routes %s AI Gateway models through the Responses format',
        (modelId) => {
            const snapshot = buildCloudflareGatewaySnapshot(modelId)

            expect(snapshot.endpoint).toEqual({ kind: 'cloudflare-ai', path: 'responses' })
            expect(snapshot.adapterKind).toBe('openai-responses')
            expect(snapshot.schema.find(field => field.key === 'openaiApiMode')).toMatchObject({
                default: 'responses',
                enum: [
                    { value: 'completions', label: 'Chat Completions' },
                    { value: 'responses', label: 'Responses' },
                ],
            })
        },
    )

    test('does not misroute a provider model whose SDK override changes the explicit recipe wire', () => {
        const vertex = provider({
            id: 'google-vertex',
            name: 'Google Vertex',
            npm: '@ai-sdk/google-vertex',
            api: undefined,
            models: {
                'claude-sonnet': model({
                    id: 'claude-sonnet',
                    provider: { npm: '@ai-sdk/openai-compatible', api: 'https://vertex.example.test/v1' },
                }),
            } as any,
        })
        const profiles = buildModelsDevRegistry({ 'google-vertex': vertex })
            .registries[MODELS_DEV_REGISTRY_ID]?.profiles
        expect(profiles).toEqual({})
    })

    test.each([
        ['unsupported wire package', 'unsupported', provider({
            id: 'unsupported',
            npm: '@ai-sdk/amazon-bedrock',
            models: { chat: model() } as any,
        })],
        ['non-text output', 'audio', provider({
            id: 'audio',
            models: { speech: model({ id: 'speech', modalities: { input: ['text'], output: ['audio'] } }) } as any,
        })],
        ['local endpoint', 'local', provider({
            id: 'local',
            api: 'http://localhost:11434/v1',
            models: { chat: model() } as any,
        })],
        ['unresolved endpoint template', 'templated', provider({
            id: 'templated',
            api: 'https://${REGION}.example.test/v1',
            models: { chat: model() } as any,
        })],
    ] as const)('filters a provider with %s', (_reason, id, entry) => {
        const profiles = buildModelsDevRegistry({ [id]: entry } as ModelsDevCatalog)
            .registries[MODELS_DEV_REGISTRY_ID]?.profiles
        expect(profiles).toEqual({})
    })
})

describe('validateModelsDevCatalog', () => {
    test('requires keyed provider ids and a models object', () => {
        expect(validateModelsDevCatalog({ demo: provider() })).toBe(true)
        expect(validateModelsDevCatalog({ demo: { ...provider(), id: 'wrong' } })).toBe(false)
        expect(validateModelsDevCatalog([])).toBe(false)
    })
})

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
    test('turns an OpenAI-compatible provider/model into a complete snapshot', () => {
        const catalog = {
            demo: provider({ models: { chat: model() } as any }),
        }
        const registry = buildModelsDevRegistry(catalog)
        const snapshot = resolveSnapshot(registry, 'demo:chat')

        expect(Object.keys(registry.registries)).toEqual([MODELS_DEV_REGISTRY_ID])
        expect(snapshot.adapterKind).toBe('openai-compatible')
        expect(snapshot.endpoint.url).toBe('https://api.demo.test/v1/chat/completions')
        expect(snapshot.auth).toEqual({ kind: 'bearer', fields: ['apiKey'] })
        expect(snapshot.uiSchema.fields.filter((field) => field.key === 'apiKey')).toHaveLength(1)
        expect(snapshot.uiSchema.fields.find((field) => field.key === 'apiKey'))
            .toMatchObject({ widget: 'secret', visibility: 'info', group: 'credentials' })
        expect(snapshot.modelId).toBe('chat')
        expect(snapshot.schema.some((field) => field.key === 'modelId')).toBe(false)
        expect(snapshot.uiSchema.fields.some((field) => field.key === 'modelId')).toBe(false)
        expect(snapshot.capabilities).toEqual(
            expect.arrayContaining(['streaming', 'vision', 'tools', 'json', 'reasoning']),
        )
        expect(snapshot.limits).toMatchObject({
            known: true,
            contextWindowTokens: 128000,
            maxOutputTokens: 16384,
        })
        expect(snapshot.schema.find((field) => field.key === 'reasoning_effort')
            ?.enum?.map((option) => option.value)).toEqual(['low', 'high'])
        expect(snapshot.schema.find((field) => field.key === 'reasoning_effort'))
            .toMatchObject({ labelKey: 'reasoningEffort', helpKey: 'reasoningEffort' })
        expect(snapshot.uiSchema.groups.map((group) => group.id)).toEqual(
            expect.arrayContaining(['connection', 'generation']),
        )
        expect(snapshot.uiSchema.fields.find((field) => field.key === 'reasoning_effort'))
            .toMatchObject({ visibility: 'basic', layout: 'row', group: 'connection' })
        expect(snapshot.schema.find((field) => field.key === 'max_tokens')?.max).toBe(16384)
        expect(snapshot.schema.find((field) => field.key === 'max_tokens')?.mapsTo)
            .toEqual({ target: 'body', path: 'max_tokens' })
        expect(snapshot.uiSchema.fields.find((field) => field.key === 'max_tokens'))
            .toMatchObject({
                widget: 'slider',
                visibility: 'basic',
                layout: 'row',
                disableable: true,
                group: 'generation',
            })
        expect(snapshot.uiSchema.fields.find((field) => field.key === 'temperature'))
            .toMatchObject({
                widget: 'slider',
                layout: 'row',
                disableable: true,
                fixed: 2,
                group: 'generation',
            })

        const profile = registry.registries[MODELS_DEV_REGISTRY_ID]?.profiles?.['demo:chat']
        expect(profile).toMatchObject({
            modelReleaseDate: '2026-01-01',
        })
        expect(profile?.description).not.toContain('Released:')
        expect(profile?.description).not.toContain('Knowledge cutoff:')
    })

    test('adds token-budget reasoning controls to Claude and Gemini profiles', () => {
        const anthropic = provider({
            id: 'anthropic',
            name: 'Anthropic',
            npm: '@ai-sdk/anthropic',
            models: {
                'claude-sonnet': model({ id: 'claude-sonnet', family: 'claude' }),
            } as any,
        })
        const google = provider({
            id: 'google',
            name: 'Google',
            npm: '@ai-sdk/google',
            models: {
                'gemini-pro': model({ id: 'gemini-pro', family: 'gemini' }),
            } as any,
        })
        const registry = buildModelsDevRegistry({ anthropic, google })
        const claude = resolveSnapshot(registry, 'anthropic:claude-sonnet')
        const gemini = resolveSnapshot(registry, 'google:gemini-pro')

        expect(claude.schema.find((field) => field.key === 'effort')
            ?.enum?.map((option) => option.value)).toEqual(['low', 'high', 'budget'])
        expect(gemini.schema.find((field) => field.key === 'thinkingLevel')
            ?.enum?.map((option) => option.value)).toEqual(['low', 'high', 'budget'])
        expect(claude.schema.find((field) => field.key === 'effort')?.mapsTo)
            .toEqual({ target: 'body', path: 'output_config.effort' })
        expect(gemini.schema.find((field) => field.key === 'thinkingLevel')?.mapsTo)
            .toEqual({
                target: 'body',
                path: 'generationConfig.thinkingConfig.thinkingLevel',
            })
        expect(gemini.schema.find((field) => field.key === 'maxOutputTokens')?.mapsTo)
            .toEqual({ target: 'body', path: 'generationConfig.maxOutputTokens' })
        for (const [snapshot, reasoningKey] of [
            [claude, 'effort'],
            [gemini, 'thinkingLevel'],
        ] as const) {
            expect(snapshot.schema.find((field) => field.key === 'thinking_tokens'))
                .toMatchObject({
                    type: 'integer',
                    labelKey: 'thinkingTokens',
                    helpKey: 'thinkingBudgetHelp',
                    default: 1024,
                    min: 1024,
                })
            expect(snapshot.uiSchema.fields.find((field) => field.key === 'thinking_tokens'))
                .toMatchObject({
                    widget: 'number-input',
                    visibility: 'basic',
                    group: 'connection',
                    showIf: { key: reasoningKey, equals: 'budget' },
                })
        }
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

    test('adds a Completions/Responses selector to GPT models on any provider', () => {
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
        const gpt = resolveSnapshot(registry, 'other-gateway:openai/gpt-5')
        const claude = resolveSnapshot(registry, 'other-gateway:anthropic/claude-sonnet')
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

    test('builds Amazon Bedrock Converse and Mantle models with regional auth fields', () => {
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
        const profiles = registry.registries[MODELS_DEV_REGISTRY_ID]?.profiles ?? {}
        const native = resolveSnapshot(
            registry,
            'amazon-bedrock:global.anthropic.claude-sonnet',
        )
        const mantle = resolveSnapshot(
            registry,
            'amazon-bedrock:openai.gpt-5.6-sol',
        )

        expect(Object.keys(profiles)).toHaveLength(3)
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

        expect(mantle.adapterKind).toBe('openai-responses')
        expect(mantle.endpoint).toEqual({
            kind: 'amazon-bedrock-mantle',
            path: 'openai/v1/responses',
        })
        expect(mantle.auth.kind).toBe('aws-bedrock')
        expect(mantle.schema.find((field) => field.key === 'bedrockRegion')?.default)
            .toBe('us-east-1')
        expect(mantle.schema.find((field) => field.key === 'openaiApiMode')?.default)
            .toBe('completions')
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
        expect(snapshot.endpoint).toEqual({ kind: 'cloudflare-ai' })
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

    test('keeps all AI Gateway models on Cloudflare even when model SDK metadata differs', () => {
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
                'anthropic/claude-sonnet': model({
                    id: 'anthropic/claude-sonnet',
                    name: 'Claude Sonnet',
                    family: 'claude',
                    provider: {
                        npm: '@ai-sdk/anthropic',
                        api: 'https://api.anthropic.com/v1',
                    },
                }),
            } as any,
        })
        const registry = buildModelsDevRegistry({ 'cloudflare-ai-gateway': gateway })
        const profiles = registry.registries[MODELS_DEV_REGISTRY_ID]?.profiles ?? {}
        const claude = resolveSnapshot(
            registry,
            'cloudflare-ai-gateway:anthropic/claude-sonnet',
        )

        expect(Object.keys(profiles)).toHaveLength(2)
        expect(claude.adapterKind).toBe('openai-compatible')
        expect(claude.endpoint).toEqual({ kind: 'cloudflare-ai' })
        expect(claude.auth.fields).toEqual(['cloudflareApiToken'])
        expect(claude.headerTemplate['cf-aig-gateway-id']).toBe('default')
        expect(claude.schema.some((field) => field.key === 'cloudflareGatewayId')).toBe(false)
        expect(claude.uiSchema.fields.some((field) => field.key === 'cloudflareGatewayId'))
            .toBe(false)
    })

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

    test('filters unsupported wire packages, non-text output, local URLs, and templates', () => {
        const catalog: ModelsDevCatalog = {
            unsupported: provider({
                id: 'unsupported',
                npm: '@ai-sdk/amazon-bedrock',
                models: { chat: model() } as any,
            }),
            audio: provider({
                id: 'audio',
                models: { speech: model({ id: 'speech', modalities: { input: ['text'], output: ['audio'] } }) } as any,
            }),
            local: provider({
                id: 'local',
                api: 'http://localhost:11434/v1',
                models: { chat: model() } as any,
            }),
            templated: provider({
                id: 'templated',
                api: 'https://${REGION}.example.test/v1',
                models: { chat: model() } as any,
            }),
        }
        const profiles = buildModelsDevRegistry(catalog)
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

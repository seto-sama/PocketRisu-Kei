import { describe, expect, test } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { buildPreparedRequest } from './buildRequest'
import { ModelPresetAdapterError } from './error'

function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:standard',
        providerBaseId: 'demo',
        adapterKind: 'openai-compatible',
        auth: { kind: 'bearer', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
        modelId: 'demo-fast',
        schema: [
            {
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        headerTemplate: { 'Content-Type': 'application/json' },
        capabilities: ['streaming'],
        ...overrides,
    }
}

function makePreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset-1',
        name: 'Demo Preset',
        profileSnapshot: makeSnapshot(),
        userValues: { modelId: 'demo-fast' },
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    }
}

const SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'sa-project',
    private_key: 'x',
    client_email: 'svc@sa-project.iam.gserviceaccount.com',
})

function vertexSchema(locationDefault = 'global') {
    return [
        {
            key: 'serviceAccountJson',
            type: 'string' as const,
            label: 'Service Account JSON',
            secret: true,
            mapsTo: { target: 'auth' as const, path: 'apiKey' },
        },
        {
            key: 'location',
            type: 'string' as const,
            label: 'Location',
            default: locationDefault,
            mapsTo: { target: 'custom' as const, path: 'location' },
        },
        {
            key: 'endpointUrl',
            type: 'string' as const,
            label: 'Endpoint URL (override)',
            mapsTo: { target: 'custom' as const, path: 'endpointUrl' },
        },
    ]
}

function vertexPreset(
    kind: 'vertex-openai' | 'vertex-gemini',
    userValues: Record<string, unknown> = {},
    locationDefault = 'global',
) {
    return makePreset({
        profileSnapshot: makeSnapshot({
            auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
            endpoint: { kind },
            schema: vertexSchema(locationDefault),
        }),
        userValues,
    })
}

function expectInvalidVertexRequest(request: () => unknown) {
    let error: unknown
    try {
        request()
    } catch (caught) {
        error = caught
    }
    expect(error).toBeInstanceOf(ModelPresetAdapterError)
    if (error instanceof ModelPresetAdapterError) {
        expect(error.kind).toBe('invalid-request')
        expect(error.retryable).toBe(false)
    }
}

describe('buildPreparedRequest', () => {
    test('builds body from defaults + bodyTemplate + userValues mapsTo + auth header', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                defaults: { stream: false, temperature: 0.5 },
                bodyTemplate: { max_tokens: 1024 },
            }),
            userValues: { modelId: 'demo-faster', temperature: 0.9 },
        })
        const result = buildPreparedRequest({
            preset,
            credential: { apiKey: 'sk-test' },
        })
        expect(result.method).toBe('POST')
        expect(result.url).toBe('https://demo.test/v1/chat/completions')
        expect(result.body).toEqual({
            stream: false,
            temperature: 0.5,
            max_tokens: 1024,
            model: 'demo-faster',
        })
        expect(result.headers).toEqual({
            'Content-Type': 'application/json',
            Authorization: 'Bearer sk-test',
        })
    })

    test('falls back to schema default when userValues lacks the key', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'reasoning',
                        type: 'string',
                        label: 'Reasoning Effort',
                        default: 'low',
                        mapsTo: { target: 'body', path: 'reasoning_effort' },
                    },
                ],
            }),
            userValues: {},
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ reasoning_effort: 'low' })
    })

    test('treats an empty-string userValue as unset (combobox cleared to blank)', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'reasoning',
                        type: 'string',
                        label: 'Reasoning Effort',
                        mapsTo: { target: 'body', path: 'reasoning_effort' },
                    },
                ],
            }),
            userValues: { reasoning: '' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).not.toHaveProperty('reasoning_effort')
    })

    test('skips fields without mapsTo and ignores auth/custom targets at body merge', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    { key: 'helpOnly', type: 'string', label: 'help only' },
                    {
                        key: 'customExt',
                        type: 'string',
                        label: 'Custom',
                        mapsTo: { target: 'custom', path: 'whatever' },
                    },
                ],
            }),
            userValues: { helpOnly: 'visible', customExt: 'ignored' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({})
    })

    test('routes header and query mapsTo targets', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'projectId',
                        type: 'string',
                        label: 'Project',
                        mapsTo: { target: 'header', path: 'X-Project-Id' },
                    },
                    {
                        key: 'apiVersion',
                        type: 'string',
                        label: 'API Version',
                        mapsTo: { target: 'query', path: 'api-version' },
                    },
                ],
            }),
            userValues: { projectId: 'proj-123', apiVersion: '2025-05-01' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.headers['X-Project-Id']).toBe('proj-123')
        expect(result.url).toBe('https://demo.test/v1/chat/completions?api-version=2025-05-01')
    })

    test('writes nested body mapsTo paths', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'thinkingBudget',
                        type: 'integer',
                        label: 'Thinking Budget',
                        mapsTo: { target: 'body', path: 'thinking.budget_tokens' },
                    },
                ],
            }),
            userValues: { thinkingBudget: 1024 },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ thinking: { budget_tokens: 1024 } })
    })

    test('customBody and customHeaders override prior merges', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                defaults: { stream: false },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'modelId',
                        type: 'string',
                        label: 'Model ID',
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
            }),
            userValues: { modelId: 'demo-fast' },
            customBody: { stream: true, model: 'demo-overridden', extra: 1 },
            customHeaders: { 'X-Custom': '1', 'Content-Type': 'application/x-custom' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ stream: true, model: 'demo-overridden', extra: 1 })
        expect(result.headers).toEqual({
            'Content-Type': 'application/x-custom',
            'X-Custom': '1',
            Authorization: 'Bearer sk',
        })
    })

    test('applies generated body defaults before user-owned body overrides', () => {
        const automatic = buildPreparedRequest({
            preset: makePreset(),
            credential: { apiKey: 'sk-test' },
            generatedBodyDefaults: { prompt_cache_key: 'automatic-key' },
        })
        expect(automatic.body.prompt_cache_key).toBe('automatic-key')

        const customPreset = makePreset({
            customBody: { prompt_cache_key: 'custom-key' },
        })
        const custom = buildPreparedRequest({
            preset: customPreset,
            credential: { apiKey: 'sk-test' },
            generatedBodyDefaults: { prompt_cache_key: 'automatic-key' },
        })
        expect(custom.body.prompt_cache_key).toBe('custom-key')

        customPreset.additionalParamsText = 'prompt_cache_key={{none}}'
        const disabled = buildPreparedRequest({
            preset: customPreset,
            credential: { apiKey: 'sk-test' },
            generatedBodyDefaults: { prompt_cache_key: 'automatic-key' },
        })
        expect(disabled.body).not.toHaveProperty('prompt_cache_key')
    })

    test('builds the Vertex OpenAI endpoint URL from selected credentials and schema location', () => {
        const preset = vertexPreset('vertex-openai', {}, 'us-central1')
        const result = buildPreparedRequest({
            preset,
            credential: { apiKey: 'ya29.token' },
            serviceAccountJson: SA_JSON,
        })
        expect(result.url).toBe(
            'https://us-central1-aiplatform.googleapis.com/v1/projects/sa-project/locations/us-central1/endpoints/openapi/chat/completions',
        )
        expect(result.headers.Authorization).toBe('Bearer ya29.token')
    })

    test('sends both Vertex routing headers for a selected Flex tier', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: { kind: 'vertex-gemini' },
                schema: [
                    {
                        key: 'serviceAccountJson',
                        type: 'string',
                        label: 'Service Account JSON',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'service_tier',
                        type: 'string',
                        label: 'Service Tier',
                        mapsTo: {
                            target: 'header',
                            path: 'X-Vertex-AI-LLM-Shared-Request-Type',
                        },
                    },
                ],
            }),
            userValues: { service_tier: 'flex' },
        })

        const result = buildPreparedRequest({
            preset,
            credential: { apiKey: 'ya29.token' },
            serviceAccountJson: SA_JSON,
        })

        expect(result.headers).toMatchObject({
            'X-Vertex-AI-LLM-Request-Type': 'shared',
            'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
        })
    })

    test('throws invalid-request when static endpoint has no url', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: '' },
            }),
        })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
                expect(err.retryable).toBe(false)
            }
        }
    })

    test('does not mutate nested objects inside snapshot defaults/bodyTemplate or customBody', () => {
        const defaults = { thinking: { type: 'enabled' as const } }
        const bodyTemplate = { tools: [{ name: 'search' }] }
        const customBody = { extras: { nested: { value: 1 } } }
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                defaults,
                bodyTemplate,
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'thinkingBudget',
                        type: 'integer',
                        label: 'Thinking Budget',
                        mapsTo: { target: 'body', path: 'thinking.budget_tokens' },
                    },
                ],
            }),
            userValues: { thinkingBudget: 1024 },
            customBody,
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({
            thinking: { type: 'enabled', budget_tokens: 1024 },
            tools: [{ name: 'search' }],
            extras: { nested: { value: 1 } },
        })
        // input objects must remain untouched
        expect(defaults).toEqual({ thinking: { type: 'enabled' } })
        expect(bodyTemplate).toEqual({ tools: [{ name: 'search' }] })
        expect(customBody).toEqual({ extras: { nested: { value: 1 } } })
        // body subtree must be its own reference graph
        expect(result.body.thinking).not.toBe(defaults.thinking)
        expect(result.body.tools).not.toBe(bodyTemplate.tools)
        expect((result.body.extras as Record<string, unknown>).nested)
            .not.toBe(customBody.extras.nested)
    })

    test('falls back to snapshot.modelId when modelId schema field default is backfilled', () => {
        // simulates the post-backfill snapshot resolveSnapshot produces for model-specific profiles
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                modelId: 'gpt-5',
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'modelId',
                        type: 'string',
                        label: 'Model ID',
                        default: 'gpt-5',
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
            }),
            userValues: {},
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ model: 'gpt-5' })
    })

    test('resolves endpoint URL from userValues when schema has custom endpointUrl mapping', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: '' },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'endpointUrl',
                        type: 'string',
                        label: 'Endpoint URL',
                        mapsTo: { target: 'custom', path: 'endpointUrl' },
                    },
                    {
                        key: 'modelId',
                        type: 'string',
                        label: 'Model ID',
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
            }),
            userValues: {
                endpointUrl: 'https://my-proxy.example/v1/chat/completions',
                modelId: 'demo-fast',
            },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.url).toBe('https://my-proxy.example/v1/chat/completions')
        expect(result.body).toEqual({ model: 'demo-fast' })
    })

    test('endpoint override takes precedence over snapshot.endpoint.url', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'endpointUrl',
                        type: 'string',
                        label: 'Endpoint URL',
                        mapsTo: { target: 'custom', path: 'endpointUrl' },
                    },
                ],
            }),
            userValues: { endpointUrl: 'https://override.example/v1' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.url).toBe('https://override.example/v1')
    })

    test('empty endpoint override throws invalid-request', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: '' },
                schema: [
                    {
                        key: 'endpointUrl',
                        type: 'string',
                        label: 'Endpoint URL',
                        mapsTo: { target: 'custom', path: 'endpointUrl' },
                    },
                ],
            }),
            userValues: { endpointUrl: '' },
        })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
            }
        }
    })

    test('userValues explicit null suppresses schema default fallback', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'reasoning',
                        type: 'string',
                        label: 'Reasoning',
                        default: 'low',
                        mapsTo: { target: 'body', path: 'reasoning_effort' },
                    },
                ],
            }),
            userValues: { reasoning: null },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ reasoning_effort: null })
    })

    test('header mapsTo overrides a value baked into headerTemplate', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                headerTemplate: {
                    'Content-Type': 'application/json',
                    'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
                },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'sharedRequestType',
                        type: 'string',
                        label: 'Shared Request Type',
                        mapsTo: { target: 'header', path: 'X-Vertex-AI-LLM-Shared-Request-Type' },
                    },
                ],
            }),
            userValues: { sharedRequestType: 'priority' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.headers['X-Vertex-AI-LLM-Shared-Request-Type']).toBe('priority')
    })

    test('empty header mapsTo value keeps the headerTemplate default', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                headerTemplate: {
                    'Content-Type': 'application/json',
                    'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
                },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'sharedRequestType',
                        type: 'string',
                        label: 'Shared Request Type',
                        mapsTo: { target: 'header', path: 'X-Vertex-AI-LLM-Shared-Request-Type' },
                    },
                ],
            }),
            userValues: { sharedRequestType: '' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.headers['X-Vertex-AI-LLM-Shared-Request-Type']).toBe('flex')
    })
})

describe('buildPreparedRequest — Vertex project/location resolution', () => {
    test('vertex-openai: blank endpoint override uses the selected credential and default location', () => {
        const preset = vertexPreset('vertex-openai', { endpointUrl: '' })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' }, serviceAccountJson: SA_JSON })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/sa-project/locations/global/endpoints/openapi/chat/completions',
        )
    })

    test('vertex-gemini: assembles its native base URL from the selected credential', () => {
        const preset = vertexPreset('vertex-gemini')
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' }, serviceAccountJson: SA_JSON })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/sa-project/locations/global/publishers/google/models',
        )
    })

    test('vertex-gemini: regional location yields the regional host', () => {
        const preset = vertexPreset('vertex-gemini', { location: 'us-east5' })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' }, serviceAccountJson: SA_JSON })
        expect(result.url).toBe(
            'https://us-east5-aiplatform.googleapis.com/v1/projects/sa-project/locations/us-east5/publishers/google/models',
        )
    })

    test('vertex-gemini: blank location falls back to global', () => {
        const preset = vertexPreset('vertex-gemini', { location: '' })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' }, serviceAccountJson: SA_JSON })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/sa-project/locations/global/publishers/google/models',
        )
    })

    test('vertex-openai: generic endpointUrl override wins over URL assembly', () => {
        const preset = vertexPreset('vertex-openai', {
            location: 'us-east5',
            endpointUrl: 'https://custom.example/v1/projects/over/locations/global/publishers/google/models',
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' }, serviceAccountJson: SA_JSON })
        expect(result.url).toBe(
            'https://custom.example/v1/projects/over/locations/global/publishers/google/models',
        )
    })

    test.each([
        ['missing', undefined],
        ['malformed', '{broken'],
        ['without project_id', JSON.stringify({ type: 'service_account', client_email: 'x' })],
    ])('rejects %s selected JSON even when userValues has a valid credential', (_case, selectedJson) => {
        const preset = vertexPreset('vertex-gemini', { serviceAccountJson: SA_JSON })
        expectInvalidVertexRequest(() => buildPreparedRequest({
            preset,
            credential: { apiKey: 'ya29.token' },
            serviceAccountJson: selectedJson,
        }))
    })

    test('ignores malformed service-account JSON in userValues when selected credentials are valid', () => {
        const preset = vertexPreset('vertex-gemini', { serviceAccountJson: '{broken' })
        const result = buildPreparedRequest({
            preset,
            credential: { apiKey: 'ya29.token' },
            serviceAccountJson: SA_JSON,
        })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/sa-project/locations/global/publishers/google/models',
        )
    })
})

describe('buildPreparedRequest — Cloudflare AI endpoint resolution', () => {
    function cloudflarePreset(
        userValues: Record<string, unknown>,
        withGateway = false,
    ) {
        return makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'bearer', fields: ['cloudflareApiToken'] },
                endpoint: { kind: 'cloudflare-ai' },
                headerTemplate: withGateway
                    ? {
                        'Content-Type': 'application/json',
                        'cf-aig-gateway-id': 'default',
                    }
                    : { 'Content-Type': 'application/json' },
                schema: [
                    {
                        key: 'cloudflareApiToken',
                        type: 'string',
                        label: 'Cloudflare API Token',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'cloudflareAccountId',
                        type: 'string',
                        label: 'Account ID',
                        required: true,
                        secret: true,
                        mapsTo: { target: 'custom', path: 'cloudflareAccountId' },
                    },
                ],
            }),
            userValues,
        })
    }

    test('builds a Workers AI request from the masked Account ID field', () => {
        const result = buildPreparedRequest({
            preset: cloudflarePreset({ cloudflareAccountId: ' account-123 ' }),
            credential: { apiKey: 'cf-token' },
        })

        expect(result.url).toBe(
            'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1/chat/completions',
        )
        expect(result.headers.Authorization).toBe('Bearer cf-token')
        expect(result.headers['cf-aig-gateway-id']).toBeUndefined()
    })

    test('defaults the AI Gateway header and allows an additional-params override', () => {
        const defaultGateway = buildPreparedRequest({
            preset: cloudflarePreset({ cloudflareAccountId: 'account-123' }, true),
            credential: { apiKey: 'cf-token' },
        })
        const namedGatewayPreset = cloudflarePreset(
            { cloudflareAccountId: 'account-123' },
            true,
        )
        namedGatewayPreset.additionalParamsText =
            'header::cf-aig-gateway-id=my-gateway'
        const namedGateway = buildPreparedRequest({
            preset: namedGatewayPreset,
            credential: { apiKey: 'cf-token' },
        })

        expect(defaultGateway.headers['cf-aig-gateway-id']).toBe('default')
        expect(namedGateway.headers['cf-aig-gateway-id']).toBe('my-gateway')
    })

    test('rejects a request whose Account ID is blank', () => {
        expect(() => buildPreparedRequest({
            preset: cloudflarePreset({ cloudflareAccountId: '' }),
            credential: { apiKey: 'cf-token' },
        })).toThrowError(ModelPresetAdapterError)
    })
})

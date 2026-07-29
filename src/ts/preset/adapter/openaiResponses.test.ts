import { describe, expect, test } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { previewResponsesRequest } from './openaiResponses'

function makeSnapshot(): ResolvedModelProfileSnapshot {
    return {
        profileId: 'openai-responses:official',
        providerBaseId: 'openai-responses',
        adapterKind: 'openai-responses',
        auth: { kind: 'bearer', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://api.openai.test/v1/responses' },
        modelId: 'gpt-5.6-sol',
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
                default: 'gpt-5.6-sol',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        headerTemplate: { 'Content-Type': 'application/json' },
        capabilities: ['vision'],
    }
}

function makePreset(): ModelPreset {
    return {
        id: 'responses-preset',
        name: 'OpenAI Responses',
        profileSnapshot: makeSnapshot(),
        userValues: {},
        gptVisionQuality: 'low',
        createdAt: 0,
        updatedAt: 0,
    }
}

describe('OpenAI Responses Vision Quality', () => {
    test('maps the preset value to input_image.detail', async () => {
        const prepared = await previewResponsesRequest(
            makePreset(),
            {
                messages: [{
                    role: 'user',
                    content: 'inspect',
                    images: [{ kind: 'image', base64: 'LOW', mime: 'image/jpeg' }],
                }],
            },
            { apiKey: 'sk-test' },
        )

        const input = prepared.body.input as Array<Record<string, any>>
        expect(input[0].content).toEqual([
            { type: 'input_text', text: 'inspect' },
            {
                type: 'input_image',
                detail: 'low',
                image_url: 'data:image/jpeg;base64,LOW',
            },
        ])
    })

    test('uses the Responses route and field shape for a switched GPT profile', async () => {
        const dynamic = makePreset()
        dynamic.profileSnapshot = {
            ...dynamic.profileSnapshot,
            profileId: 'gateway:openai/gpt-5',
            providerBaseId: 'gateway',
            adapterKind: 'openai-compatible',
            endpoint: { kind: 'static', url: 'https://gateway.test/v1/chat/completions' },
            schema: [
                dynamic.profileSnapshot.schema[0],
                {
                    key: 'openaiApiMode',
                    type: 'string',
                    label: 'OpenAI API',
                    default: 'completions',
                    mapsTo: { target: 'custom', path: 'openaiApiMode' },
                },
                {
                    key: 'max_completion_tokens',
                    type: 'integer',
                    label: 'Max Output Tokens',
                    mapsTo: { target: 'body', path: 'max_completion_tokens' },
                },
                {
                    key: 'reasoning_effort',
                    type: 'string',
                    label: 'Reasoning Effort',
                    mapsTo: { target: 'body', path: 'reasoning_effort' },
                },
            ],
        }
        dynamic.userValues = {
            openaiApiMode: 'responses',
            max_completion_tokens: 2048,
            reasoning_effort: 'high',
        }

        const prepared = await previewResponsesRequest(
            dynamic,
            { messages: [{ role: 'user', content: 'hello' }] },
            { apiKey: 'sk-test' },
        )

        expect(prepared.url).toBe('https://gateway.test/v1/responses')
        expect(prepared.body.max_output_tokens).toBe(2048)
        expect(prepared.body.reasoning).toEqual({ effort: 'high' })
        expect(prepared.body.max_completion_tokens).toBeUndefined()
        expect(prepared.body.reasoning_effort).toBeUndefined()
    })

    test('uses a regional Bedrock Mantle Responses endpoint and bearer API key', async () => {
        const dynamic = makePreset()
        dynamic.profileSnapshot = {
            ...dynamic.profileSnapshot,
            profileId: 'amazon-bedrock:xai.grok-4.3',
            providerBaseId: 'amazon-bedrock--responses',
            auth: { kind: 'aws-bedrock', fields: ['bedrockCredential'] },
            endpoint: {
                kind: 'amazon-bedrock-mantle',
                path: 'openai/v1/responses',
            },
            modelId: 'xai.grok-4.3',
            schema: [
                {
                    key: 'bedrockCredential',
                    type: 'string',
                    label: 'Credential',
                    secret: true,
                    mapsTo: { target: 'auth', path: 'apiKey' },
                },
                {
                    key: 'bedrockRegion',
                    type: 'string',
                    label: 'AWS Region',
                    default: 'us-east-1',
                    mapsTo: { target: 'custom', path: 'bedrockRegion' },
                },
            ],
        }
        dynamic.userValues = { bedrockRegion: 'ap-northeast-2' }

        const prepared = await previewResponsesRequest(
            dynamic,
            { messages: [{ role: 'user', content: 'hello' }] },
            { apiKey: 'bedrock-api-key' },
        )

        expect(prepared.url)
            .toBe('https://bedrock-mantle.ap-northeast-2.api.aws/openai/v1/responses')
        expect(prepared.headers.Authorization).toBe('Bearer bedrock-api-key')
        expect(prepared.body.model).toBe('xai.grok-4.3')
    })
})

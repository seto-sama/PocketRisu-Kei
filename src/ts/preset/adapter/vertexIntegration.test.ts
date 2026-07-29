import { describe, expect, test } from 'vitest'
import { buildModelsDevRegistry } from '../registry/modelsDev'
import { resolveSnapshot } from '../registry/snapshot'
import type { ModelPreset } from '../types'
import { buildPreparedRequest } from './buildRequest'
import { createServiceAccountTokenCache } from './googleServiceAccount/cache'
import type { ExchangeServiceAccountInput } from './googleServiceAccount/token'
import { prepareAdapterRequest } from './resolveCredential'
import { resolveWireModelId } from './wireInvariants'

const VALID_SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'demo',
    private_key_id: 'kid-1',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIBVwIB...\n-----END PRIVATE KEY-----\n',
    client_email: 'svc@demo.iam.gserviceaccount.com',
    client_id: '1',
    token_uri: 'https://oauth2.googleapis.com/token',
})

function vertexPreset(userValues: Record<string, unknown>): ModelPreset {
    const registry = buildModelsDevRegistry({
        'google-vertex': {
            id: 'google-vertex',
            name: 'Google Vertex',
            npm: '@ai-sdk/google-vertex',
            env: ['GOOGLE_APPLICATION_CREDENTIALS'],
            doc: 'https://cloud.google.com/vertex-ai/generative-ai/docs',
            models: {
                'google/gemini-2.5-pro': {
                    id: 'google/gemini-2.5-pro',
                    name: 'Gemini 2.5 Pro',
                    attachment: true,
                    reasoning: true,
                    reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
                    tool_call: true,
                    structured_output: true,
                    temperature: true,
                    release_date: '2025-06-01',
                    last_updated: '2026-01-01',
                    modalities: { input: ['text', 'image'], output: ['text'] },
                    limit: { context: 1_000_000, output: 65536 },
                },
            },
        },
    })
    return {
        id: 'preset-vertex',
        name: 'Vertex Preset',
        profileSnapshot: resolveSnapshot(
            registry,
            'google-vertex:google/gemini-2.5-pro',
        ),
        userValues,
        createdAt: 1,
        updatedAt: 1,
    }
}

function stubCache(accessToken: string) {
    const calls: ExchangeServiceAccountInput[] = []
    return {
        calls,
        cache: createServiceAccountTokenCache({
            now: () => 1_000_000,
            exchange: async (input) => {
                calls.push(input)
                return {
                    accessToken,
                    tokenType: 'Bearer',
                    expiresInSeconds: 3600,
                    issuedAtMs: 1_000_000,
                }
            },
        }),
    }
}

describe('Vertex Gemini models.dev recipe integration', () => {
    test('exchanges the service account and assembles the standard Vertex endpoint', async () => {
        const { cache, calls } = stubCache('ya29.gemini')
        const preset = vertexPreset({})

        const prepared = await prepareAdapterRequest({
            preset,
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
        })

        expect(prepared.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models',
        )
        expect(prepared.headers.Authorization).toBe('Bearer ya29.gemini')
        expect(calls).toHaveLength(1)
        expect(calls[0].serviceAccount.clientEmail).toBe('svc@demo.iam.gserviceaccount.com')
    })

    test('uses the models.dev model id as the native wire default', () => {
        const preset = vertexPreset({})
        expect(resolveWireModelId(preset, { vendorName: 'Google Gemini' }))
            .toBe('gemini-2.5-pro')
    })

    test('keeps an automatic models.dev profile pinned to its snapshot model', () => {
        const preset = vertexPreset({
            location: 'us-central1',
            // Automatic profiles no longer expose a modelId schema field, so a
            // stray value cannot redirect the fixed one-model profile.
            modelId: 'gemini-2.5-flash',
        })
        const base = buildPreparedRequest({
            preset,
            credential: { apiKey: 'ya29.token' },
            serviceAccountJson: VALID_SA_JSON,
        }).url
        const model = resolveWireModelId(preset, { vendorName: 'Google Gemini' })

        expect(`${base}/${encodeURIComponent(model)}:generateContent`).toBe(
            'https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent',
        )
    })
})

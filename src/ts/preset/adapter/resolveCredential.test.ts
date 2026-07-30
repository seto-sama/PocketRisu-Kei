import { describe, expect, test } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { ModelPresetAdapterError } from './error'
import { createServiceAccountTokenCache } from './googleServiceAccount/cache'
import type { ExchangeServiceAccountInput } from './googleServiceAccount/token'
import { resolveAdapterCredential } from './resolveCredential'

function snapshot(
    overrides: Partial<ResolvedModelProfileSnapshot> = {},
): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:standard',
        providerBaseId: 'demo',
        adapterKind: 'openai-compatible',
        auth: { kind: 'bearer', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
        modelId: 'demo-fast',
        schema: [],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        ...overrides,
    }
}

function preset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset-1',
        name: 'Demo',
        profileSnapshot: snapshot(),
        userValues: {},
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    }
}

const VALID_SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'demo',
    private_key_id: 'kid-1',
    private_key:
        '-----BEGIN PRIVATE KEY-----\nMIIBVwIB...\n-----END PRIVATE KEY-----\n',
    client_email: 'svc@demo.iam.gserviceaccount.com',
    client_id: '1',
    token_uri: 'https://oauth2.googleapis.com/token',
})

function stubCache(
    accessToken: string,
    opts: { expiresInSeconds?: number; issuedAtMs?: number; tokenType?: string } = {},
) {
    const exchange = async (_input: ExchangeServiceAccountInput) => ({
        accessToken,
        tokenType: opts.tokenType ?? 'Bearer',
        expiresInSeconds: opts.expiresInSeconds ?? 3600,
        issuedAtMs: opts.issuedAtMs ?? 1_000_000,
    })
    return createServiceAccountTokenCache({ now: () => 1_000_000, exchange })
}

describe('resolveAdapterCredential', () => {
    test('returns credential unchanged for non-SA auth kinds', async () => {
        const inputCred = { apiKey: 'sk-bearer' }
        const result = await resolveAdapterCredential({
            preset: preset({ profileSnapshot: snapshot({ auth: { kind: 'bearer' } }) }),
            credential: inputCred,
        })
        expect(result).toBe(inputCred)
    })

    test('passes through undefined credential for non-SA kinds', async () => {
        const result = await resolveAdapterCredential({
            preset: preset({ profileSnapshot: snapshot({ auth: { kind: 'none' } }) }),
        })
        expect(result).toBeUndefined()
    })

    test('exchanges SA JSON for an access token via the cache', async () => {
        const cache = stubCache('ya29.testtoken')
        const result = await resolveAdapterCredential({
            preset: preset({
                profileSnapshot: snapshot({
                    auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                }),
            }),
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
        })
        expect(result?.apiKey).toBe('ya29.testtoken')
        expect(result?.inlineCredential).toMatchObject({
            kind: 'google-service-account',
            tokenType: 'Bearer',
            clientEmail: 'svc@demo.iam.gserviceaccount.com',
        })
    })

    test('throws auth error when SA credential is missing apiKey', async () => {
        const cache = stubCache('tok')
        await expectAdapterError(
            () =>
                resolveAdapterCredential({
                    preset: preset({
                        profileSnapshot: snapshot({
                            auth: {
                                kind: 'google-service-account',
                                fields: ['serviceAccountJson'],
                            },
                        }),
                    }),
                    tokenCache: cache,
                }),
            { kind: 'auth', retryable: false, fallbackEligible: false },
        )

        await expectAdapterError(
            () =>
                resolveAdapterCredential({
                    preset: preset({
                        profileSnapshot: snapshot({
                            auth: {
                                kind: 'google-service-account',
                                fields: ['serviceAccountJson'],
                            },
                        }),
                    }),
                    credential: { apiKey: '' },
                    tokenCache: cache,
                }),
            { kind: 'auth', retryable: false, fallbackEligible: false },
        )
    })

    test('rethrows parse error from invalid SA JSON', async () => {
        const cache = stubCache('tok')
        await expectAdapterError(
            () =>
                resolveAdapterCredential({
                    preset: preset({
                        profileSnapshot: snapshot({
                            auth: {
                                kind: 'google-service-account',
                                fields: ['serviceAccountJson'],
                            },
                        }),
                    }),
                    credential: { apiKey: '{not-json' },
                    tokenCache: cache,
                }),
            { kind: 'invalid-request', retryable: false, fallbackEligible: false },
        )
    })

    test('forwards scope to the cache but never the caller signal to the shared exchange', async () => {
        const captured: ExchangeServiceAccountInput[] = []
        const exchange = async (input: ExchangeServiceAccountInput) => {
            captured.push(input)
            return {
                accessToken: 'tok',
                tokenType: 'Bearer',
                expiresInSeconds: 3600,
                issuedAtMs: 1_000_000,
            }
        }
        const cache = createServiceAccountTokenCache({ now: () => 1_000_000, exchange })
        const controller = new AbortController()
        await resolveAdapterCredential({
            preset: preset({
                profileSnapshot: snapshot({
                    auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                }),
            }),
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
            scope: 'https://www.googleapis.com/auth/aiplatform',
            abortSignal: controller.signal,
        })
        expect(captured).toHaveLength(1)
        expect(captured[0].scope).toBe('https://www.googleapis.com/auth/aiplatform')
        // Caller signal is consumed by the cache's per-caller race, not by the
        // shared exchange — see cache.ts.
        expect(captured[0].abortSignal).toBeUndefined()
    })
})

async function expectAdapterError(
    fn: () => Promise<unknown>,
    expected: {
        kind?: ModelPresetAdapterError['kind']
        retryable?: boolean
        fallbackEligible?: boolean
    },
): Promise<void> {
    try {
        await fn()
        throw new Error('expected throw')
    } catch (err) {
        expect(err).toBeInstanceOf(ModelPresetAdapterError)
        if (!(err instanceof ModelPresetAdapterError)) return
        if (expected.kind !== undefined) expect(err.kind).toBe(expected.kind)
        if (expected.retryable !== undefined) expect(err.retryable).toBe(expected.retryable)
        if (expected.fallbackEligible !== undefined)
            expect(err.fallbackEligible).toBe(expected.fallbackEligible)
    }
}

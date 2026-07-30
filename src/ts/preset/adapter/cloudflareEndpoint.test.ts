import { describe, expect, test } from 'vitest'
import { ModelPresetAdapterError } from './error'
import { buildCloudflareAiEndpointUrl } from './cloudflareEndpoint'

describe('buildCloudflareAiEndpointUrl', () => {
    test('builds the shared Workers AI / AI Gateway chat endpoint', () => {
        expect(buildCloudflareAiEndpointUrl('0123456789abcdef')).toBe(
            'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef/ai/v1/chat/completions',
        )
    })

    test('trims the account id', () => {
        expect(buildCloudflareAiEndpointUrl('  account-id  ')).toContain(
            '/accounts/account-id/ai/v1/chat/completions',
        )
    })

    test('rejects a missing account id as a non-retryable request error', () => {
        for (const accountId of [undefined, '', '   ']) {
            try {
                buildCloudflareAiEndpointUrl(accountId)
                throw new Error('expected throw')
            } catch (err) {
                expect(err).toBeInstanceOf(ModelPresetAdapterError)
                if (err instanceof ModelPresetAdapterError) {
                    expect(err.kind).toBe('invalid-request')
                    expect(err.retryable).toBe(false)
                    expect(err.fallbackEligible).toBe(false)
                }
            }
        }
    })
})

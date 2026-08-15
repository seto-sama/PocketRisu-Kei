import { describe, expect, test } from 'vitest'
import { ModelPresetAdapterError } from './error'
import {
    buildCloudflareAiEndpointUrl,
    normalizeCloudflareAiModelId,
} from './cloudflareEndpoint'

describe('normalizeCloudflareAiModelId', () => {
    test.each([
        ['anthropic/claude-opus-4-6', 'anthropic/claude-opus-4.6'],
        ['anthropic/claude-sonnet-4-5', 'anthropic/claude-sonnet-4.5'],
        ['anthropic/claude-opus-4-6-20260101', 'anthropic/claude-opus-4.6-20260101'],
        ['workers-ai/@cf/meta/llama', '@cf/meta/llama'],
        ['openai/gpt-5.6', 'openai/gpt-5.6'],
    ])('normalizes %s', (input, expected) => {
        expect(normalizeCloudflareAiModelId(input)).toBe(expected)
    })
})

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

    test('builds the Responses and Anthropic Messages endpoints', () => {
        expect(buildCloudflareAiEndpointUrl('account', 'responses')).toBe(
            'https://api.cloudflare.com/client/v4/accounts/account/ai/v1/responses',
        )
        expect(buildCloudflareAiEndpointUrl('account', 'messages')).toBe(
            'https://api.cloudflare.com/client/v4/accounts/account/ai/v1/messages',
        )
    })

    test('normalizes a configured endpoint path', () => {
        expect(buildCloudflareAiEndpointUrl('account', '/messages/')).toBe(
            'https://api.cloudflare.com/client/v4/accounts/account/ai/v1/messages',
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

import { describe, expect, it } from 'vitest'
import { classifyPluginProviderFetch } from './providerFetchClassification'

const dependencyPlaceholder = '__RISU_REVENANT_HYPA_123e4567-e89b__'

describe('classifyPluginProviderFetch', () => {
    it('keeps an OAuth form POST outside generation transport', () => {
        const request = {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials&assertion=jwt',
        }
        expect(classifyPluginProviderFetch(
            'https://oauth2.googleapis.com/token', request, dependencyPlaceholder,
        )).toEqual({ generation: false })
        expect(classifyPluginProviderFetch(
            'https://oauth2.googleapis.com/token', request,
        )).toEqual({ generation: false })
    })

    it('selects only the dependent Gemini body carrying the workflow placeholder', () => {
        expect(classifyPluginProviderFetch(
            'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini:streamGenerateContent',
            {
                method: 'POST',
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: `memory ${dependencyPlaceholder}` }] }],
                }),
            },
            dependencyPlaceholder,
        )).toEqual({
            generation: true,
            adapterKind: 'google-gemini',
            streaming: true,
        })
        expect(classifyPluginProviderFetch(
            'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini:streamGenerateContent',
            {
                method: 'POST',
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: 'no deferred memory here' }] }],
                }),
            },
            dependencyPlaceholder,
        )).toEqual({ generation: false })
    })

    it('recognizes OpenAI Responses generation without a workflow dependency', () => {
        expect(classifyPluginProviderFetch(
            'https://api.openai.com/v1/responses',
            {
                method: 'POST',
                body: { model: 'gpt-test', input: 'hello', stream: true },
            },
        )).toEqual({
            generation: true,
            adapterKind: 'openai-responses',
            streaming: true,
        })
    })

    it('recognizes a proxied OpenAI-compatible message body', () => {
        expect(classifyPluginProviderFetch(
            'https://proxy.example.test/request',
            {
                method: 'POST',
                body: { model: 'custom', messages: [{ role: 'user', content: 'hello' }] },
            },
        )).toEqual({
            generation: true,
            adapterKind: 'openai-compatible',
            streaming: false,
        })
    })

    it('does not mistake Gemini explicit-cache management for generation', () => {
        expect(classifyPluginProviderFetch(
            'https://generativelanguage.googleapis.com/v1beta/cachedContents',
            {
                method: 'POST',
                body: { model: 'models/gemini-test', contents: [{ role: 'user', parts: [{ text: 'cached' }] }] },
            },
        )).toEqual({ generation: false })
    })

    it('keeps GET requests outside generation transport', () => {
        expect(classifyPluginProviderFetch(
            'https://api.example.test/v1/messages',
            { method: 'GET' },
        )).toEqual({ generation: false })
    })
})

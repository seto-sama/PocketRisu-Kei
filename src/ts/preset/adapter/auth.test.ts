import { describe, expect, test } from 'vitest'
import { appendQuery, applyAuth } from './auth'
import { ModelPresetAdapterError } from './error'
import type { AdapterPreparedRequest } from './types'

function basePrepared(overrides: Partial<AdapterPreparedRequest> = {}): AdapterPreparedRequest {
    return {
        method: 'POST',
        url: 'https://demo.test/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
        body: {},
        ...overrides,
    }
}

describe('applyAuth', () => {
    test('none leaves request untouched', () => {
        const result = applyAuth(basePrepared(), { kind: 'none' }, undefined)
        expect(result.headers).toEqual({ 'Content-Type': 'application/json' })
        expect(result.url).toBe('https://demo.test/v1/chat/completions')
    })

    test('bearer adds Authorization header', () => {
        const result = applyAuth(basePrepared(), { kind: 'bearer' }, { apiKey: 'sk-test' })
        expect(result.headers.Authorization).toBe('Bearer sk-test')
    })

    test('x-api-key adds header', () => {
        const result = applyAuth(basePrepared(), { kind: 'x-api-key' }, { apiKey: 'ant-1' })
        expect(result.headers['x-api-key']).toBe('ant-1')
    })

    test('x-goog-api-key adds header', () => {
        const result = applyAuth(basePrepared(), { kind: 'x-goog-api-key' }, { apiKey: 'goog-1' })
        expect(result.headers['x-goog-api-key']).toBe('goog-1')
    })

    test('query appends key as ?key=', () => {
        const result = applyAuth(basePrepared(), { kind: 'query' }, { apiKey: 'k+1' })
        expect(result.url).toBe('https://demo.test/v1/chat/completions?key=k%2B1')
    })

    test('query appends with & when URL already has ?', () => {
        const result = applyAuth(
            basePrepared({ url: 'https://demo.test/v1?already=here' }),
            { kind: 'query' },
            { apiKey: 'k' },
        )
        expect(result.url).toBe('https://demo.test/v1?already=here&key=k')
    })

    test('throws auth error when bearer credential is missing', () => {
        try {
            applyAuth(basePrepared(), { kind: 'bearer' }, undefined)
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('auth')
                expect(err.retryable).toBe(false)
            }
        }
    })

    test('throws auth error for empty string apiKey', () => {
        expect(() => applyAuth(basePrepared(), { kind: 'bearer' }, { apiKey: '' }))
            .toThrowError(ModelPresetAdapterError)
    })

    test('google-service-account adds Authorization bearer header (token is supplied upstream)', () => {
        const result = applyAuth(
            basePrepared(),
            { kind: 'google-service-account' },
            { apiKey: 'ya29.access-token' },
        )
        expect(result.headers.Authorization).toBe('Bearer ya29.access-token')
    })

    test('google-service-account throws auth error when no access token is present', () => {
        try {
            applyAuth(basePrepared(), { kind: 'google-service-account' }, undefined)
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('auth')
                expect(err.retryable).toBe(false)
            }
        }
    })

    test('does not mutate input headers', () => {
        const prepared = basePrepared()
        const result = applyAuth(prepared, { kind: 'bearer' }, { apiKey: 'sk' })
        expect(prepared.headers.Authorization).toBeUndefined()
        expect(result.headers.Authorization).toBe('Bearer sk')
    })

    test('replaces existing auth header case-insensitively', () => {
        const result = applyAuth(
            basePrepared({ headers: { authorization: 'Bearer fake', 'Content-Type': 'application/json' } }),
            { kind: 'bearer' },
            { apiKey: 'sk-real' },
        )
        expect(result.headers).toEqual({
            'Content-Type': 'application/json',
            Authorization: 'Bearer sk-real',
        })
    })
})

describe('appendQuery', () => {
    test('escapes key and value', () => {
        expect(appendQuery('https://demo.test/v1', 'a b', 'c=d&e')).toBe(
            'https://demo.test/v1?a%20b=c%3Dd%26e',
        )
    })

    test('appends with & to existing query', () => {
        expect(appendQuery('https://demo.test/v1?x=1', 'y', '2')).toBe(
            'https://demo.test/v1?x=1&y=2',
        )
    })
})

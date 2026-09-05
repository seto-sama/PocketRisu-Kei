import { describe, expect, test } from 'vitest'
import {
    ModelPresetAdapterError,
    defaultFallbackEligible,
    defaultRetryable,
    extractErrorMessage,
    normalizeFetchError,
    normalizeHttpStatus,
    parseRetryAfterMs,
    normalizeProviderStreamError,
} from './error'

describe('extractErrorMessage', () => {
    test('returns error.message for OpenAI/Anthropic/Google AI Studio shape', () => {
        expect(
            extractErrorMessage(JSON.stringify({ error: { message: 'rate limited' } })),
        ).toBe('rate limited')
    })

    test('returns bare message field', () => {
        expect(extractErrorMessage(JSON.stringify({ message: 'short msg' }))).toBe('short msg')
    })

    test('returns Google OAuth error_description', () => {
        expect(
            extractErrorMessage(
                JSON.stringify({ error_description: 'JWT signature is invalid.' }),
            ),
        ).toBe('JWT signature is invalid.')
    })

    test('combines Google OAuth error code with error_description', () => {
        expect(
            extractErrorMessage(
                JSON.stringify({
                    error: 'invalid_grant',
                    error_description: 'Bad assertion JWT',
                }),
            ),
        ).toBe('invalid_grant: Bad assertion JWT')
    })

    test('returns plain error string when only Google OAuth error code is present', () => {
        expect(extractErrorMessage(JSON.stringify({ error: 'invalid_grant' }))).toBe(
            'invalid_grant',
        )
    })

    test('truncates non-JSON body to 200 chars', () => {
        const long = 'x'.repeat(500)
        const got = extractErrorMessage(long)
        expect(got).toBe('x'.repeat(200))
    })

    test('returns null when body is empty', () => {
        expect(extractErrorMessage('')).toBeNull()
    })

    test('returns null for JSON without any known field', () => {
        expect(extractErrorMessage(JSON.stringify({ unrelated: 'thing' }))).toBeNull()
    })

    test('error.message wins over message wins over error_description wins over error', () => {
        // Priority order regression guard.
        expect(
            extractErrorMessage(
                JSON.stringify({
                    error: { message: 'first' },
                    message: 'second',
                    error_description: 'third',
                }),
            ),
        ).toBe('first')
        expect(
            extractErrorMessage(
                JSON.stringify({
                    message: 'second',
                    error_description: 'third',
                    error: 'invalid_grant',
                }),
            ),
        ).toBe('second')
        expect(
            extractErrorMessage(
                JSON.stringify({ error_description: 'third', error: 'invalid_grant' }),
            ),
        ).toBe('invalid_grant: third')
    })
})

describe('defaultRetryable', () => {
    test('marks network/timeout/rate-limit/server/parse as retryable', () => {
        for (const kind of ['network', 'timeout', 'rate-limit', 'server', 'parse'] as const) {
            expect(defaultRetryable(kind)).toBe(true)
        }
    })

    test('marks auth/invalid-request/not-found/aborted/unsupported as non-retryable', () => {
        for (const kind of [
            'auth',
            'invalid-request',
            'not-found',
            'aborted',
            'unsupported',
            'unknown',
        ] as const) {
            expect(defaultRetryable(kind)).toBe(false)
        }
    })
})

describe('defaultFallbackEligible', () => {
    test('marks network/timeout/server/parse as fallback-eligible (plan §9-8)', () => {
        for (const kind of ['network', 'timeout', 'server', 'parse'] as const) {
            expect(defaultFallbackEligible(kind)).toBe(true)
        }
    })

    test('marks rate-limit as fallback non-eligible even though it is retryable', () => {
        expect(defaultFallbackEligible('rate-limit')).toBe(false)
        expect(defaultRetryable('rate-limit')).toBe(true)
    })

    test('marks auth/invalid-request/not-found/aborted/unsupported/unknown as non-eligible', () => {
        for (const kind of [
            'auth',
            'invalid-request',
            'not-found',
            'aborted',
            'unsupported',
            'unknown',
        ] as const) {
            expect(defaultFallbackEligible(kind)).toBe(false)
        }
    })
})

describe('ModelPresetAdapterError', () => {
    test('options.retryable and options.fallbackEligible override defaults independently', () => {
        const err = new ModelPresetAdapterError('network', 'override', {
            retryable: false,
            fallbackEligible: false,
        })
        expect(err.retryable).toBe(false)
        expect(err.fallbackEligible).toBe(false)
    })

    test('toAdapterError exposes plain shape with fallbackEligible', () => {
        const cause = new Error('underlying')
        const err = new ModelPresetAdapterError('server', 'boom', { status: 502, cause })
        expect(err.toAdapterError()).toEqual({
            kind: 'server',
            message: 'boom',
            status: 502,
            retryable: true,
            fallbackEligible: true,
            cause,
        })
    })
})

describe('normalizeFetchError', () => {
    test('returns the same instance if already normalized', () => {
        const original = new ModelPresetAdapterError('network', 'x')
        expect(normalizeFetchError(original)).toBe(original)
    })

    test('AbortError maps to aborted/non-retryable', () => {
        const abort = new Error('aborted')
        abort.name = 'AbortError'
        const err = normalizeFetchError(abort)
        expect(err.kind).toBe('aborted')
        expect(err.retryable).toBe(false)
    })

    test('generic Error maps to network/retryable', () => {
        const err = normalizeFetchError(new Error('fetch failed'))
        expect(err.kind).toBe('network')
        expect(err.retryable).toBe(true)
    })

    test('non-Error value maps to unknown', () => {
        const err = normalizeFetchError('boom')
        expect(err.kind).toBe('unknown')
        expect(err.message).toBe('boom')
    })
})

describe('normalizeHttpStatus', () => {
    test('returns null for 2xx', () => {
        expect(normalizeHttpStatus(200)).toBeNull()
        expect(normalizeHttpStatus(204)).toBeNull()
    })

    test('401/403 -> auth non-retryable', () => {
        for (const status of [401, 403]) {
            const err = normalizeHttpStatus(status)!
            expect(err.kind).toBe('auth')
            expect(err.retryable).toBe(false)
            expect(err.status).toBe(status)
        }
    })

    test('404 -> not-found non-retryable', () => {
        const err = normalizeHttpStatus(404)!
        expect(err.kind).toBe('not-found')
        expect(err.retryable).toBe(false)
    })

    test('408 -> timeout retryable', () => {
        const err = normalizeHttpStatus(408)!
        expect(err.kind).toBe('timeout')
        expect(err.retryable).toBe(true)
    })

    test('429 -> rate-limit retryable but fallback non-eligible', () => {
        const err = normalizeHttpStatus(429)!
        expect(err.kind).toBe('rate-limit')
        expect(err.retryable).toBe(true)
        expect(err.fallbackEligible).toBe(false)
    })

    test('other 4xx -> invalid-request non-retryable', () => {
        const err = normalizeHttpStatus(422)!
        expect(err.kind).toBe('invalid-request')
        expect(err.retryable).toBe(false)
    })

    test('5xx -> server retryable and fallback-eligible', () => {
        for (const status of [500, 502, 503]) {
            const err = normalizeHttpStatus(status)!
            expect(err.kind).toBe('server')
            expect(err.retryable).toBe(true)
            expect(err.fallbackEligible).toBe(true)
        }
    })

    test('outside common ranges -> unknown', () => {
        const err = normalizeHttpStatus(600)!
        expect(err.kind).toBe('unknown')
    })
})

describe('parseRetryAfterMs', () => {
    test('parses delta-seconds', () => {
        expect(parseRetryAfterMs('2.5')).toBe(2_500)
    })

    test('parses an HTTP date relative to now', () => {
        const now = Date.parse('2026-08-23T00:00:00Z')
        expect(parseRetryAfterMs('Sun, 23 Aug 2026 00:00:07 GMT', now)).toBe(7_000)
    })

    test('ignores invalid and negative values', () => {
        expect(parseRetryAfterMs('later')).toBeUndefined()
        expect(parseRetryAfterMs('-1')).toBeUndefined()
        expect(parseRetryAfterMs(null)).toBeUndefined()
    })
})

describe('normalizeProviderStreamError', () => {
    test('uses the normal HTTP classification when a stream payload includes status', () => {
        expect(normalizeProviderStreamError({ status: 503, message: 'busy' }, 'fallback'))
            .toMatchObject({ kind: 'server', retryable: true, fallbackEligible: true })
    })

    test('recognizes status-less provider overload messages', () => {
        expect(normalizeProviderStreamError({
            type: 'server_error',
            message: 'Too many requests',
        }, 'fallback')).toMatchObject({
            kind: 'rate-limit',
            retryable: true,
            fallbackEligible: false,
        })
    })
})

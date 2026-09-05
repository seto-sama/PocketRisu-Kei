import { describe, expect, test } from 'vitest'
import { overloadRetryBaseDelayMs, requestRetryDelayMs } from './retryPolicy'

describe('request retry policy', () => {
    test('uses the 1s / 5s / 10s overload tiers', () => {
        expect([1, 2, 3, 4, 5, 6, 20].map(overloadRetryBaseDelayMs)).toEqual([
            1_000, 1_000, 1_000, 5_000, 5_000, 10_000, 10_000,
        ])
    })

    test('adds up to 20 percent jitter without shortening the tier delay', () => {
        expect(requestRetryDelayMs({ failByServerError: true }, 1, 6, () => 0)).toBe(1_000)
        expect(requestRetryDelayMs({ failByServerError: true }, 4, 6, () => 0.5)).toBe(5_500)
        expect(requestRetryDelayMs({ failByServerError: true }, 6, 6, () => 1)).toBe(12_000)
    })

    test('uses Retry-After as-is and does not jitter it', () => {
        expect(requestRetryDelayMs(
            { failByServerError: true, retryAfterMs: 7_250 },
            2,
            3,
            () => 1,
        )).toBe(7_250)
    })

    test('retries other transient failures immediately within the same budget', () => {
        expect(requestRetryDelayMs({}, 1, 2)).toBe(0)
        expect(requestRetryDelayMs({}, 2, 2)).toBe(0)
        expect(requestRetryDelayMs({}, 3, 2)).toBeNull()
    })

    test('does not wait after the final failed attempt', () => {
        expect(requestRetryDelayMs({ failByServerError: true }, 3, 2)).toBeNull()
        expect(requestRetryDelayMs({ failByServerError: true }, 1, Number.NaN)).toBeNull()
    })
})

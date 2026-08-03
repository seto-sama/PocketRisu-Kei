import { describe, expect, test } from 'vitest'
import {
    GenerationJobRegistrationError,
    isGenerationJobFallbackEligible,
} from './stream'

describe('generation job registration fallback policy', () => {
    test.each([404, 405, 501])('allows compatibility fallback for HTTP %s', status => {
        expect(isGenerationJobFallbackEligible(
            new GenerationJobRegistrationError(status, 'unsupported'),
        )).toBe(true)
    })

    test.each([400, 401, 409, 429, 500])('does not bypass durable policy for HTTP %s', status => {
        expect(isGenerationJobFallbackEligible(
            new GenerationJobRegistrationError(status, 'rejected'),
        )).toBe(false)
    })

    test('does not fallback after an ambiguous network failure', () => {
        expect(isGenerationJobFallbackEligible(new TypeError('Failed to fetch'))).toBe(false)
    })
})

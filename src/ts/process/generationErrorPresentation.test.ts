import { describe, expect, it } from 'vitest'
import { shouldSuppressGenerationErrorModal } from './generationErrorPresentation'

describe('generation error presentation', () => {
    it('suppresses the provider busy message without requiring status metadata', () => {
        expect(shouldSuppressGenerationErrorModal(
            "We're currently processing too many requests — please try again later.",
        )).toBe(true)
    })

    it('suppresses structured transient provider failures', () => {
        expect(shouldSuppressGenerationErrorModal({
            result: 'limited',
            failByServerError: true,
        })).toBe(true)
        expect(shouldSuppressGenerationErrorModal({
            message: 'quota exhausted',
            kind: 'rate-limit',
            status: 429,
        })).toBe(true)
    })

    it('keeps actionable request errors visible', () => {
        expect(shouldSuppressGenerationErrorModal({
            result: 'API key is invalid',
            noRetry: true,
        })).toBe(false)
        expect(shouldSuppressGenerationErrorModal('Invalid JSON schema')).toBe(false)
    })
})

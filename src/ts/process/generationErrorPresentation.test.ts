import { describe, expect, it } from 'vitest'
import { shouldSuppressGenerationErrorModal } from './generationErrorPresentation'

describe('generation error presentation', () => {
    it('treats a rejected Hypa wait as cancellation only when generation was cancelled', () => {
        const controller = new AbortController()
        const error = new DOMException('The operation was aborted.', 'AbortError')
        expect(shouldSuppressGenerationErrorModal(error, controller.signal)).toBe(false)
        controller.abort()
        expect(shouldSuppressGenerationErrorModal(error, controller.signal)).toBe(true)
        expect(shouldSuppressGenerationErrorModal({ result: 'cancelled' }, controller.signal)).toBe(true)
    })
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

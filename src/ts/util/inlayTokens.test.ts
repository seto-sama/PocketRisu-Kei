import { describe, expect, it } from 'vitest'
import { canonicalizeInlayTokens } from './inlayTokens'

describe('canonicalizeInlayTokens', () => {
    it('canonicalizes legacy inlay references when saving new text', () => {
        expect(canonicalizeInlayTokens('a {{inlay::asset}} b'))
            .toBe('a {{inlayed::asset}} b')
    })

    it('preserves canonical and model-visible inlay references', () => {
        const value = '{{inlayed::display}}{{inlayeddata::model}}'
        expect(canonicalizeInlayTokens(value)).toBe(value)
    })
})

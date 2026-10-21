import { describe, expect, it } from 'vitest'
import { getProfileUpdateStatus } from './customProfiles'
import type { ModelProfile } from './types'

describe('getProfileUpdateStatus', () => {
    const withUpdatedAt = (updatedAt?: number) => ({ updatedAt } as ModelProfile)

    it('returns missing when the current profile is undefined', () => {
        expect(getProfileUpdateStatus(undefined, 100)).toBe('missing')
    })

    it('returns updatable when the current profile is newer', () => {
        expect(getProfileUpdateStatus(withUpdatedAt(200), 100)).toBe('updatable')
    })

    it('returns none when the revision is equal or older', () => {
        expect(getProfileUpdateStatus(withUpdatedAt(100), 100)).toBe('none')
        expect(getProfileUpdateStatus(withUpdatedAt(50), 100)).toBe('none')
    })

    it('returns none when either timestamp is unknown', () => {
        expect(getProfileUpdateStatus(withUpdatedAt(undefined), 100)).toBe('none')
        expect(getProfileUpdateStatus(withUpdatedAt(200), undefined)).toBe('none')
    })
})

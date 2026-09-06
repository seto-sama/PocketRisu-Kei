import { describe, expect, it } from 'vitest'
import { DEFAULT_TRASH_RETENTION_DAYS, isTrashExpired, normalizeTrashRetentionDays } from '../trashRetention'

const deletedAt = Date.UTC(2026, 8, 1)
const day = 24 * 60 * 60 * 1000

describe('trash retention', () => {
    it('preserves the three-day schedule for existing databases', () => {
        expect(normalizeTrashRetentionDays(undefined)).toBe(DEFAULT_TRASH_RETENTION_DAYS)
        expect(isTrashExpired(deletedAt, undefined, deletedAt + 3 * day)).toBe(false)
        expect(isTrashExpired(deletedAt, undefined, deletedAt + 3 * day + 1)).toBe(true)
    })

    it('never expires trash when automatic deletion is disabled', () => {
        expect(isTrashExpired(deletedAt, 0, deletedAt + 3650 * day)).toBe(false)
    })

    it('uses the deletion timestamp and chosen retention, not the settings change time', () => {
        const now = deletedAt + 4 * day
        expect(isTrashExpired(deletedAt, 7, now)).toBe(false)
        expect(isTrashExpired(deletedAt, 2, now)).toBe(true)
    })

    it.each([undefined, null, 0, NaN, Infinity, -1])('never deletes an untrashed or invalid entry (%s)', timestamp => {
        expect(isTrashExpired(timestamp, 3, deletedAt + 4 * day)).toBe(false)
    })

    it('normalizes the schedule to nonnegative whole days', () => {
        expect(normalizeTrashRetentionDays(2.8)).toBe(2)
        expect(normalizeTrashRetentionDays(-1)).toBe(0)
        expect(normalizeTrashRetentionDays(NaN)).toBe(DEFAULT_TRASH_RETENTION_DAYS)
    })
})

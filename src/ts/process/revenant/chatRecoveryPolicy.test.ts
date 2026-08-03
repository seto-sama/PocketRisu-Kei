import { describe, expect, it } from 'vitest'
import {
    clientActionRecoveryMode,
    MAIN_JOB_REGISTRATION_GRACE_MS,
    mainRecoveryStatusAction,
    shouldWaitForMainJobRegistration,
} from './chatRecoveryPolicy'

describe('revenant chat recovery policy', () => {
    it('waits briefly for job registration without allowing pre-model recovery', () => {
        const createdAt = 10_000
        expect(shouldWaitForMainJobRegistration(
            createdAt,
            createdAt + MAIN_JOB_REGISTRATION_GRACE_MS - 1,
        )).toBe(true)
        expect(shouldWaitForMainJobRegistration(
            createdAt,
            createdAt + MAIN_JOB_REGISTRATION_GRACE_MS,
        )).toBe(false)
    })

    it('recovers post-model client actions in the background while a main projection exists', () => {
        expect(clientActionRecoveryMode(true, 1)).toBe('background')
        expect(clientActionRecoveryMode(true, 0)).toBe('blocking')
        expect(clientActionRecoveryMode(false, 1)).toBe('none')
    })

    it('does not resurrect a status toast for a main request already completed on entry', () => {
        expect(mainRecoveryStatusAction('generated', false)).toBe('none')
        expect(mainRecoveryStatusAction('failed', false)).toBe('none')
    })

    it('starts only active requests and closes requests observed becoming terminal', () => {
        expect(mainRecoveryStatusAction('generating', false)).toBe('start')
        expect(mainRecoveryStatusAction('generated', true)).toBe('done')
        expect(mainRecoveryStatusAction('cancelled', true)).toBe('aborted')
        expect(mainRecoveryStatusAction('failed_partial', true)).toBe('failed')
    })
})

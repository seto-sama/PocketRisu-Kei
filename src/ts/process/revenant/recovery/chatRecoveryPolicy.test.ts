import { describe, expect, it } from 'vitest'
import {
    clientActionRecoveryMode,
    MAIN_JOB_REGISTRATION_GRACE_MS,
    recoveryStatusAction,
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
        expect(recoveryStatusAction('generated', false)).toBe('none')
        expect(recoveryStatusAction('failed', false)).toBe('none')
    })

    it('starts only active requests and closes requests observed becoming terminal', () => {
        expect(recoveryStatusAction('generating', false)).toBe('start')
        expect(recoveryStatusAction('generated', true)).toBe('done')
        expect(recoveryStatusAction('cancelled', true)).toBe('aborted')
        expect(recoveryStatusAction('failed_partial', true)).toBe('failed')
    })

    it('keeps queued and already-terminal auxiliary recovery jobs silent', () => {
        expect(recoveryStatusAction('queued', false, { startQueued: false })).toBe('none')
        expect(recoveryStatusAction('failed', false)).toBe('none')
        expect(recoveryStatusAction('generated', false)).toBe('none')
    })

    it('tracks an active auxiliary request through its terminal state', () => {
        expect(recoveryStatusAction('generating', false)).toBe('start')
        expect(recoveryStatusAction('generated', true)).toBe('done')
        expect(recoveryStatusAction('cancelled', true)).toBe('aborted')
        expect(recoveryStatusAction('failed', true)).toBe('failed')
    })
})

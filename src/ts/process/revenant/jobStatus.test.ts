import { describe, expect, it } from 'vitest'
import {
    resolveRevenantTerminalRequestOutcome,
    revenantTerminalRequestOutcome,
} from './jobStatus'

describe('revenantTerminalRequestOutcome', () => {
    it('uses one durable terminal classification for live and recovered requests', () => {
        expect(revenantTerminalRequestOutcome('generated')).toBe('done')
        expect(revenantTerminalRequestOutcome('cancelled')).toBe('aborted')
        expect(revenantTerminalRequestOutcome('interrupted')).toBe('failed')
        expect(revenantTerminalRequestOutcome('failed_partial')).toBe('failed')
        expect(revenantTerminalRequestOutcome('failed')).toBe('failed')
        expect(revenantTerminalRequestOutcome('generating')).toBeUndefined()
    })

    it('lets the durable server downgrade clean EOF without masking local failures', () => {
        expect(resolveRevenantTerminalRequestOutcome('done', 'cancelled')).toBe('aborted')
        expect(resolveRevenantTerminalRequestOutcome('done', 'failed_partial')).toBe('failed')
        expect(resolveRevenantTerminalRequestOutcome('failed', 'generated')).toBe('failed')
    })
})

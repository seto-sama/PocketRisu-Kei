import { describe, expect, it } from 'vitest'
import {
    bindRevenantTerminalOutcome,
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

    it('composes the caller terminal hook with the shared outcome resolver', () => {
        let observed = ''
        const target = {
            onRevenantTerminal: (terminal: any) => { observed = terminal.status },
        }
        const lifecycle = bindRevenantTerminalOutcome(target)

        target.onRevenantTerminal({ status: 'cancelled' } as any)

        expect(observed).toBe('cancelled')
        expect(lifecycle.resolve('done')).toBe('aborted')
    })
})

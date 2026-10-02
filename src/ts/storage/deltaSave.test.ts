// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createDelta, applyDelta } from '../../../shared/guardedDelta.mjs'
import { DeltaSave } from './deltaSave'

describe('uncertain projection saves', () => {
    it('confirms the previous write before diffing a newer edit, even if the response was lost', async () => {
        let accepted = { prompt: 'A' }
        let server = structuredClone(accepted)
        let loseResponse = true
        const save = new DeltaSave<typeof accepted, void>(async request => {
            server = applyDelta(server, request.changes)
            if (loseResponse) { loseResponse = false; throw new TypeError('Failed to fetch') }
        }, snapshot => { accepted = snapshot })

        const first = { prompt: 'C' }
        await expect(save.save({ changes: createDelta(accepted, first) }, first)).rejects.toThrow('Failed to fetch')
        expect(save.hasPending).toBe(true)
        const last = { prompt: 'B' }
        await save.flush()
        expect(save.hasPending).toBe(false)
        await save.save({ changes: createDelta(accepted, last) }, last)
        expect(server).toEqual(last)
        expect(accepted).toEqual(last)
    })
})

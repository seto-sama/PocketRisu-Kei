import { describe, expect, it } from 'vitest'
import { preparePatchConflictRebase } from './patchRebase'

describe('patch conflict rebase', () => {
    it('keeps the server pre-image as the retry hash baseline', () => {
        const latestServer = {
            characters: [],
            botPresets: [],
            modules: [],
            personaPrompt: 'server',
        }
        const rejectedPatch = [{
            op: 'replace',
            path: '/personaPrompt',
            value: 'local',
        }]

        const { serverBaseline, mergedValue } = preparePatchConflictRebase(
            latestServer,
            rejectedPatch,
        )

        expect(serverBaseline.personaPrompt).toBe('server')
        expect(mergedValue.personaPrompt).toBe('local')

        // Replaying must not mutate the object later installed as the patch
        // protocol baseline. The retry diff is server -> merged/local.
        expect(serverBaseline).toEqual(latestServer)
        expect(serverBaseline).not.toBe(latestServer)
        expect(mergedValue).not.toBe(serverBaseline)
    })
})

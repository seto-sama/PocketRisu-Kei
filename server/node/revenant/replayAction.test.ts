// @vitest-environment node
import { describe, expect, it } from 'vitest'
import replayPkg from './replayAction.cjs'

const {
    normalizeReplayActionId,
    resolveReplayAction,
    waitingClientError,
    parseWaitingClientError,
} = replayPkg as any

describe('Revenant replay actions', () => {
    it('normalizes long ids and reuses the same key for replay lookup', () => {
        const raw = `trigger.${'nested.'.repeat(30)}provider.llm`
        const actionId = normalizeReplayActionId(raw)
        expect(actionId.length).toBeLessThanOrEqual(128)
        expect(resolveReplayAction({}, raw, 'provider.llm', { prompt: 'hello' }).action.actionId).toBe(actionId)
        expect(resolveReplayAction({ [actionId]: 'done' }, raw, 'provider.llm', {}).value).toBe('done')
    })

    it('round-trips a waiting action through the Lua suspension error', () => {
        const action = { schemaVersion: 1, actionId: 'lua:0', kind: 'ui.input', payload: {} }
        expect(parseWaitingClientError(waitingClientError(action))).toEqual(action)
    })
})

import { describe, expect, it } from 'vitest'
import { buildTriggerAction, canExecuteTriggerAction, normalizeTriggerActionResult } from './triggerActionCore'

const context = {
    read: (effect: any, field = 'value', typeField = `${field}Type`) => (
        effect[typeField] === 'var' ? `var:${effect[field]}` : String(effect[field] ?? '')
    ),
    render: String,
    outputVar: (effect: any) => String(effect.outputVar ?? ''),
}

describe('Trigger typed actions', () => {
    it('normalizes provider effects and permissions', () => {
        const action = buildTriggerAction({
            type: 'v2RunLLM', value: 'prompt', valueType: 'value', model: 'submodel',
            streaming: true, outputVar: 'result',
        }, context)!
        expect(action).toEqual({
            kind: 'provider.llm',
            payload: { prompt: 'prompt', mode: 'submodel', streaming: true },
            outputVar: 'result',
            permission: 'lowLevel',
        })
        expect(canExecuteTriggerAction(action, false)).toBe(false)
        expect(normalizeTriggerActionResult(action, { success: true, result: 'done' })).toBe('done')
    })

    it('uses one unit for wait actions', () => {
        expect(buildTriggerAction({ type: 'v2Wait', value: '2', valueType: 'value' }, context))
            .toMatchObject({ kind: 'utility.wait', payload: { durationMs: 2000 } })
    })
})

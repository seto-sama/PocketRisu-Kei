import { describe, expect, it } from 'vitest'
import { evaluateTriggerConditions, type TriggerConditionLike } from './triggerConditionCore'

function evaluate(conditions: TriggerConditionLike[]) {
    return evaluateTriggerConditions({
        conditions,
        getVar: key => ({ mood: 'happy', count: '2' })[key] ?? 'null',
        render: value => String(value ?? '').replace('{{target}}', 'happy'),
        messages: [{ data: 'first message' }, { data: 'Second HAPPY message' }],
    })
}

describe('Trigger condition core', () => {
    it('evaluates variables, values, and chat indices through one renderer', () => {
        expect(evaluate([
            { type: 'var', var: 'mood', operator: '=', value: '{{target}}' },
            { type: 'var', var: 'count', operator: '>=', value: '2' },
            { type: 'chatindex', operator: '=', value: '2' },
        ])).toBe(true)
    })

    it('supports strict, loose, regex, and historical depth zero searches', () => {
        expect(evaluate([{ type: 'exists', type2: 'loose', value: 'happy', depth: 1 }])).toBe(true)
        expect(evaluate([{ type: 'exists', type2: 'strict', value: 'first', depth: 0 }])).toBe(true)
        expect(evaluate([{ type: 'exists', type2: 'regex', value: '[', depth: 2 }])).toBe(false)
    })
})

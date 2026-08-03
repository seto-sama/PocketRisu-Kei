import { describe, expect, it } from 'vitest'
import { createTriggerV2Core, type TriggerV2Effect } from './triggerV2Core'

function runCore(effects: TriggerV2Effect[]) {
    const variables: Record<string, string> = {}
    const locals: Record<number, Record<string, string>> = {}
    let indent = 0
    const getLocal = (key: string) => {
        for (let level = indent; level >= 0; level--) {
            if (locals[level]?.[key] !== undefined) return locals[level][key]
        }
        return undefined
    }
    const core = createTriggerV2Core({
        effects,
        render: value => String(value ?? ''),
        getVar: key => getLocal(key) ?? variables[key] ?? 'null',
        setVar: (key, value) => {
            for (let level = indent; level >= 0; level--) {
                if (locals[level]?.[key] !== undefined) {
                    locals[level][key] = String(value)
                    return
                }
            }
            variables[key] = String(value)
        },
        declareLocal: (key, value, level) => {
            locals[level] ||= {}
            locals[level][key] = String(value)
        },
        clearLocals: level => {
            for (const key of Object.keys(locals)) {
                if (Number(key) >= level) delete locals[Number(key)]
            }
        },
    })
    const delegated: string[] = []
    for (let index = 0; index < effects.length; index++) {
        indent = effects[index].indent ?? 0
        const result = core.step(index)
        if (!result.handled) delegated.push(effects[index].type || '')
        else index = result.nextIndex
        if (result.stop) break
    }
    return { variables, delegated }
}

describe('Trigger v2 core', () => {
    it('owns control flow, local variables, and deterministic data effects', () => {
        const result = runCore([
            { type: 'v2DeclareLocalVar', var: 'sum', value: '0', valueType: 'value', indent: 0 },
            { type: 'v2LoopNTimes', value: '3', valueType: 'value', indent: 0 },
            { type: 'v2SetVar', var: 'sum', value: '1', valueType: 'value', operator: '+=', indent: 1 },
            { type: 'v2EndIndent', indent: 1, endOfLoop: true },
            { type: 'v2IfAdvanced', source: 'sum', sourceType: 'var', target: '3', targetType: 'value', condition: '=', indent: 0 },
            { type: 'v2SetVar', var: 'passed', value: 'yes', valueType: 'value', operator: '=', indent: 1 },
            { type: 'v2EndIndent', indent: 1 },
            { type: 'v2MakeArrayVar', var: 'items', indent: 0 },
            { type: 'v2PushArrayVar', var: 'items', value: 'alpha', valueType: 'value', indent: 0 },
            { type: 'v2PushArrayVar', var: 'items', value: 'beta', valueType: 'value', indent: 0 },
            {
                type: 'v2JoinArrayVar', var: 'items', varType: 'var', delimiter: ',',
                delimiterType: 'value', outputVar: 'joined', indent: 0,
            },
        ])

        expect(result.delegated).toEqual([])
        expect(result.variables).toMatchObject({
            passed: 'yes',
            items: '["alpha","beta"]',
            joined: 'alpha,beta',
        })
    })

    it('delegates effects that require an environment adapter', () => {
        const result = runCore([
            { type: 'v2RunLLM', value: 'prompt', indent: 0 },
            { type: 'v2ShowAlert', value: 'done', indent: 0 },
        ])

        expect(result.delegated).toEqual(['v2RunLLM', 'v2ShowAlert'])
    })
})

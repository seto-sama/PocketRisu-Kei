import { describe, expect, test, vi } from 'vitest'
import { runRevenantTriggerProgram } from './runtime'

describe('Revenant trigger runtime', () => {
    test('owns V2 flow, permission checks, and normalized action outputs', async () => {
        const variables: Record<string, string> = {}
        const executeAction = vi.fn(async action => action.kind === 'provider.llm'
            ? { success: false, result: 'failed' }
            : undefined)

        await runRevenantTriggerProgram({
            effects: [
                { type: 'v2IfAdvanced', source: '1', sourceType: 'value', target: '1', targetType: 'value', condition: '=', indent: 0 },
                { type: 'v2RunLLM', value: 'prompt', valueType: 'value', model: 'model', outputVar: 'result', indent: 1 },
                { type: 'v2EndIndent', indent: 1 },
                { type: 'v2ImgGen', value: 'image', valueType: 'value', negValue: '', negValueType: 'value', outputVar: 'image', indent: 0 },
            ],
            core: {
                render: value => String(value ?? ''),
                getVar: key => variables[key] ?? 'null',
                setVar: (key, value) => { variables[key] = value },
                declareLocal: () => {},
                clearLocals: () => {},
            },
            lowLevelAccess: true,
            executeAction,
        })

        expect(variables.result).toBe('null')
        expect(executeAction.mock.calls.map(([action]) => action.kind)).toEqual([
            'provider.llm',
            'image.generate',
        ])
    })

    test('delegates only environment-specific effects to the host', async () => {
        const executeUnhandled = vi.fn(async (_effect: { type?: string }) => undefined)

        await runRevenantTriggerProgram({
            effects: [
                { type: 'v2SetVar', var: 'owned', value: 'yes', valueType: 'value', operator: '=', indent: 0 },
                { type: 'triggerlua', code: 'return true' },
                { type: 'v2GetDisplayState', outputVar: 'display', indent: 0 },
            ],
            core: {
                render: value => String(value ?? ''),
                getVar: () => 'null',
                setVar: () => {},
                declareLocal: () => {},
                clearLocals: () => {},
            },
            lowLevelAccess: false,
            executeAction: async () => undefined,
            executeUnhandled,
        })

        expect(executeUnhandled.mock.calls.map(([effect]) => effect.type)).toEqual([
            'triggerlua',
            'v2GetDisplayState',
        ])
    })
})

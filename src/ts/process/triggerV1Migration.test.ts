import { describe, expect, test } from 'vitest'
import type { triggerscript } from './triggers'
import { migrateTriggerV1ToV2 } from './triggerV1Migration'

describe('runtime Trigger V1 migration', () => {
    test('preserves trigger metadata and nests V1 conditions as current V2 blocks', () => {
        const source: triggerscript[] = [{
            comment: 'Legacy event',
            type: 'output',
            lowLevelAccess: true,
            moduleId: 'module-a',
            conditions: [{ type: 'var', var: 'enabled', operator: 'true', value: '' }, {
                type: 'exists', value: 'needle', type2: 'strict', depth: 4,
            }, {
                type: 'chatindex', operator: '>=', value: '3',
            }],
            effect: [{ type: 'stop' }],
        }]

        const result = migrateTriggerV1ToV2(source)

        expect(result[0].effect).toEqual([{ type: 'v2Header', code: '', indent: 0 }])
        expect(result[1]).toMatchObject({
            comment: 'Legacy event',
            type: 'output',
            lowLevelAccess: true,
            moduleId: 'module-a',
            conditions: [],
        })
        expect(result[1].effect.map(effect => [effect.type, 'indent' in effect ? effect.indent : undefined])).toEqual([
            ['v2IfAdvanced', 0],
            ['v2DeclareLocalVar', 1],
            ['v2QuickSearchChat', 1],
            ['v2IfAdvanced', 1],
            ['v2DeclareLocalVar', 2],
            ['v2GetMessageCount', 2],
            ['v2IfAdvanced', 2],
            ['v2StopPromptSending', 3],
            ['v2EndIndent', 3],
            ['v2EndIndent', 2],
            ['v2EndIndent', 1],
        ])
        expect(result[1].effect[0]).toMatchObject({ condition: '≡', target: 'true' })
    })

    test('maps LLMs, alerts, selection separators, and output variables', () => {
        const source: triggerscript[] = [{
            comment: 'effects',
            type: 'manual',
            conditions: [],
            effect: [
                { type: 'runLLM', value: 'main', inputVar: 'mainResult' },
                { type: 'runAxLLM', value: 'aux', inputVar: 'auxResult' },
                { type: 'showAlert', alertType: 'error', value: 'problem', inputVar: '' },
                { type: 'showAlert', alertType: 'input', value: 'question', inputVar: 'answer' },
                { type: 'showAlert', alertType: 'select', value: 'a§b§c', inputVar: 'choice' },
            ],
        }]

        const effects = migrateTriggerV1ToV2(source)[1].effect
        expect(effects).toEqual([
            { type: 'v2RunLLM', value: 'main', valueType: 'value', model: 'model', streaming: false, outputVar: 'mainResult', indent: 0 },
            { type: 'v2RunLLM', value: 'aux', valueType: 'value', model: 'submodel', streaming: false, outputVar: 'auxResult', indent: 0 },
            { type: 'v2ShowAlert', value: 'problem', valueType: 'value', indent: 0 },
            { type: 'v2GetAlertInput', display: 'question', displayType: 'value', outputVar: 'answer', indent: 0 },
            { type: 'v2GetAlertSelect', display: '', displayType: 'value', value: 'a|b|c', valueType: 'value', outputVar: 'choice', indent: 0 },
        ])
    })

    test('maps every remaining V1 effect to its current V2 equivalent', () => {
        const source: triggerscript[] = [{
            comment: 'all effects',
            type: 'start',
            conditions: [],
            effect: [
                { type: 'setvar', operator: '+=', var: 'count', value: '2' },
                { type: 'cutchat', start: '1', end: '3' },
                { type: 'modifychat', index: '0', value: 'edited' },
                { type: 'runImgGen', value: 'image', negValue: 'bad', inputVar: 'imageResult' },
                { type: 'extractRegex', value: 'abc', regex: '(a)', flags: 'g', result: '$1', inputVar: 'match' },
                { type: 'checkSimilarity', source: 'query', value: 'a§b', inputVar: 'similar' },
                { type: 'sendAIprompt' },
                { type: 'systemprompt', location: 'historyend', value: 'system' },
                { type: 'impersonate', role: 'char', value: 'hello' },
                { type: 'command', value: '/command' },
                { type: 'runtrigger', value: 'Another event' },
            ],
        }]

        const effects = migrateTriggerV1ToV2(source)[1].effect
        expect(effects.map(effect => effect.type)).toEqual([
            'v2SetVar',
            'v2CutChat',
            'v2ModifyChat',
            'v2ImgGen',
            'v2ExtractRegex',
            'v2CheckSimilarity',
            'v2SendAIprompt',
            'v2SystemPrompt',
            'v2Impersonate',
            'v2Command',
            'v2RunTrigger',
        ])
        expect(effects[0]).toMatchObject({ operator: '+=', var: 'count', value: '2', valueType: 'value' })
        expect(effects[3]).toMatchObject({ outputVar: 'imageResult', negValueType: 'value' })
        expect(effects[4]).toMatchObject({ outputVar: 'match', regexType: 'value', resultType: 'value' })
        expect(effects[5]).toMatchObject({ outputVar: 'similar', sourceType: 'value', valueType: 'value' })
    })

    test('creates a V2 header for an otherwise empty V1 collection', () => {
        const source: triggerscript[] = [{
            comment: 'empty', type: 'manual', conditions: [], effect: [],
        }]

        const result = migrateTriggerV1ToV2(source)

        expect(result[0].effect[0].type).toBe('v2Header')
        expect(result[1]).toMatchObject({ comment: 'empty', type: 'manual', conditions: [], effect: [] })
    })

    test('creates a V2 header for an empty trigger array', () => {
        expect(migrateTriggerV1ToV2([])).toEqual([{
            comment: '',
            type: 'manual',
            conditions: [],
            effect: [{ type: 'v2Header', code: '', indent: 0 }],
        }])
    })

    test('does not mutate persisted input or rewrite Lua and existing V2 triggers', () => {
        const source: triggerscript[] = [{
            comment: '', type: 'manual', conditions: [],
            effect: [{ type: 'v2Header', code: '', indent: 0 }],
        }, {
            comment: 'Current', type: 'manual', conditions: [],
            effect: [{ type: 'v2ShowAlert', value: 'ok', valueType: 'value', indent: 0 }],
        }, {
            comment: 'Lua', type: 'start', conditions: [],
            effect: [{ type: 'triggerlua', code: 'function onStart() end' }],
        }]
        const snapshot = structuredClone(source)

        const result = migrateTriggerV1ToV2(source)

        expect(result).toBe(source)
        expect(source).toEqual(snapshot)
    })

    test('keeps the generated header first when a merged module header appears later', () => {
        const source: triggerscript[] = [{
            comment: 'Legacy', type: 'manual', conditions: [],
            effect: [{ type: 'setvar', operator: '=', var: 'value', value: '1' }],
        }, {
            comment: '', type: 'manual', conditions: [],
            effect: [{ type: 'v2Header', code: '', indent: 0 }],
        }]

        const result = migrateTriggerV1ToV2(source)

        expect(result[0].effect[0].type).toBe('v2Header')
        expect(result[1].effect[0].type).toBe('v2SetVar')
        expect(result[2].effect[0].type).toBe('v2Header')
    })
})

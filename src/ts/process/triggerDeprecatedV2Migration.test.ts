import { describe, expect, test } from 'vitest'
import type { triggerscript } from './triggers'
import type { TriggerV2Effect } from './triggerV2Core'
import { hasDeprecatedTriggerV2, migrateDeprecatedTriggerV2 } from './triggerDeprecatedV2Migration'
import { runRevenantTriggerProgram } from './revenant/trigger/runtime'

const scripts = (effect: triggerscript['effect'][number]): triggerscript[] => [{
    comment: 'Event', type: 'manual', conditions: [], effect: [effect],
}]

async function executeMigrated(
    effects: triggerscript['effect'],
    lorebooks: Array<Record<string, unknown>>,
): Promise<Record<string, string>> {
    const variables: Record<string, string> = {}
    await runRevenantTriggerProgram({
        effects: effects as unknown as TriggerV2Effect[],
        core: {
            render: value => String(value ?? ''),
            getVar: key => variables[key] ?? 'null',
            setVar: (key, value) => { variables[key] = value },
            declareLocal: (key, value) => { variables[key] = String(value ?? 'null') },
            clearLocals: () => {},
            character: { globalLore: lorebooks },
        },
        lowLevelAccess: false,
        executeAction: async () => undefined,
    })
    return variables
}

describe('deprecated Trigger V2 migration', () => {
    test('renames effects that already share exact runtime behavior', () => {
        const source: triggerscript[] = [{
            comment: 'Aliases', type: 'manual', conditions: [], effect: [{
                type: 'v2If', source: 'enabled', target: '1', targetType: 'value', condition: '=', indent: 0,
            }, {
                type: 'v2GetLorebookCount', outputVar: 'count', indent: 1,
            }, {
                type: 'v2GetLorebookEntry', index: '2', indexType: 'value', outputVar: 'entry', indent: 1,
            }, {
                type: 'v2SetLorebookActivation', index: '2', indexType: 'value', value: true, indent: 1,
            }, {
                type: 'v2EndIndent', indent: 1,
            }],
        }]

        const result = migrateDeprecatedTriggerV2(source)

        expect(result[0].effect).toEqual([{
            type: 'v2IfAdvanced', source: 'enabled', sourceType: 'var',
            target: '1', targetType: 'value', condition: '=', indent: 0,
        }, {
            type: 'v2GetLorebookCountNew', outputVar: 'count', indent: 1,
        }, {
            type: 'v2GetLorebookByIndex', index: '2', indexType: 'value', outputVar: 'entry', indent: 1,
        }, {
            type: 'v2SetLorebookAlwaysActive', index: '2', indexType: 'value', value: true, indent: 1,
        }, {
            type: 'v2EndIndent', indent: 1,
        }])
    })

    test('expands name lookup into first-index extraction and indexed reading', () => {
        const result = migrateDeprecatedTriggerV2(scripts({
            type: 'v2GetLorebook', target: 'Profile', targetType: 'value', outputVar: 'content', indent: 2,
        }))[0].effect

        expect(result.map(effect => [effect.type, 'indent' in effect ? effect.indent : undefined])).toEqual([
            ['v2SetVar', 2],
            ['v2DeclareLocalVar', 2],
            ['v2DeclareLocalVar', 2],
            ['v2GetLorebookByName', 2],
            ['v2GetArrayVar', 2],
            ['v2IfAdvanced', 2],
            ['v2GetLorebookByIndex', 3],
            ['v2EndIndent', 3],
        ])
        expect(result[3]).toMatchObject({ name: 'Profile', nameType: 'value' })
        expect(result[6]).toMatchObject({ outputVar: 'content', indexType: 'var' })
    })

    test('returns the original array when no deprecated effects exist', () => {
        const source = scripts({ type: 'v2GetLorebookCountNew', outputVar: 'count', indent: 0 })
        expect(hasDeprecatedTriggerV2(source)).toBe(false)
        expect(migrateDeprecatedTriggerV2(source)).toBe(source)
    })

    test('uses the first case-insensitive name match for reads and preserves missing results', async () => {
        const read = migrateDeprecatedTriggerV2(scripts({
            type: 'v2GetLorebook', target: 'profile', targetType: 'value', outputVar: 'content', indent: 0,
        }))[0].effect
        const missingRead = migrateDeprecatedTriggerV2(scripts({
            type: 'v2GetLorebook', target: 'missing', targetType: 'value', outputVar: 'content', indent: 0,
        }))[0].effect
        const missingIndex = migrateDeprecatedTriggerV2(scripts({
            type: 'v2GetLorebookIndexViaName', name: 'missing', nameType: 'value', outputVar: 'index', indent: 0,
        }))[0].effect
        const lorebooks = [
            { comment: 'Profile', content: 'first' },
            { comment: 'PROFILE', content: 'second' },
        ]

        await expect(executeMigrated(read, lorebooks)).resolves.toMatchObject({ content: 'first' })
        await expect(executeMigrated(missingRead, lorebooks)).resolves.toMatchObject({ content: 'null' })
        await expect(executeMigrated(missingIndex, lorebooks)).resolves.toMatchObject({ index: '-1' })
    })

    test('modifies only the first matching lorebook by index', async () => {
        const effects = migrateDeprecatedTriggerV2(scripts({
            type: 'v2ModifyLorebook', target: 'profile', targetType: 'value',
            value: 'updated', valueType: 'value', indent: 0,
        }))[0].effect
        const lorebooks = [
            { comment: 'Profile', key: 'first-key', content: 'first', insertorder: 10 },
            { comment: 'PROFILE', key: 'second-key', content: 'second', insertorder: 20 },
        ]

        await executeMigrated(effects, lorebooks)

        expect(lorebooks).toEqual([
            { comment: 'Profile', key: 'first-key', content: 'updated', insertorder: 10 },
            { comment: 'PROFILE', key: 'second-key', content: 'second', insertorder: 20 },
        ])
    })
})

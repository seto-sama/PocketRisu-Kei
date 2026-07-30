import { describe, expect, test } from 'vitest'
import type { customscript } from 'src/ts/storage/database.svelte'
import {
    groupRegexScripts,
    removeRegexScriptGroup,
    reorderRegexScriptGroups,
    syncRegexScriptGroup,
    toggleRegexScriptType,
} from './regexScriptGroups'

function script(type: string, overrides: Partial<customscript> = {}): customscript {
    return {
        comment: 'shared',
        in: 'target',
        out: 'replacement',
        type,
        flag: 'gi',
        ableFlag: true,
        ...overrides,
    }
}

describe('regex script type groups', () => {
    test('groups matching records with different active types', () => {
        const input = script('editinput')
        const output = script('editoutput')
        const groups = groupRegexScripts([input, output])

        expect(groups).toHaveLength(1)
        expect(groups[0].scripts).toEqual([input, output])
    })

    test('does not collapse duplicate records of the same type or disabled records', () => {
        const groups = groupRegexScripts([
            script('editinput'),
            script('editinput'),
            script('disabled'),
            script('disabled'),
        ])

        expect(groups).toHaveLength(4)
    })

    test('ignores retained flag values while FLAGS is disabled', () => {
        const input = script('editinput', {
            ableFlag: false,
            flag: 'g',
        })
        const output = script('editoutput', {
            ableFlag: undefined,
            flag: 'ims',
        })

        expect(groupRegexScripts([input, output])).toHaveLength(1)
    })

    test('still distinguishes different flag values while FLAGS is enabled', () => {
        const input = script('editinput', { flag: 'g' })
        const output = script('editoutput', { flag: 'i' })

        expect(groupRegexScripts([input, output])).toHaveLength(2)
    })

    test('adds a type as another upstream-compatible single-type record', () => {
        const original = script('editinput')
        const result = toggleRegexScriptType(
            [original],
            groupRegexScripts([original])[0],
            'editdisplay',
        )

        expect(result).toEqual([
            original,
            { ...original, type: 'editdisplay' },
        ])
        expect(result.every((item) => typeof item.type === 'string')).toBe(true)
        expect(result.every((item) => !('types' in item))).toBe(true)
    })

    test('turns off one selected type and disables the last selected type', () => {
        const input = script('editinput')
        const output = script('editoutput')
        let scripts = [input, output]

        scripts = toggleRegexScriptType(
            scripts,
            groupRegexScripts(scripts)[0],
            'editoutput',
        )
        expect(scripts).toEqual([input])

        scripts = toggleRegexScriptType(
            scripts,
            groupRegexScripts(scripts)[0],
            'editinput',
        )
        expect(scripts).toEqual([{ ...input, type: 'disabled' }])
    })

    test('disabled clears every selected type but keeps the primary record', () => {
        const input = script('editinput')
        const output = script('editoutput')
        const display = script('editdisplay')
        const result = toggleRegexScriptType(
            [input, output, display],
            groupRegexScripts([input, output, display])[0],
            'disabled',
        )

        expect(result).toHaveLength(1)
        expect(result[0]).toBe(input)
        expect(result[0].type).toBe('disabled')
    })

    test('keeps shared fields synchronized across type records', () => {
        const input = script('editinput')
        const output = script('editoutput')
        const group = groupRegexScripts([input, output])[0]
        input.comment = 'renamed'
        input.out = 'new replacement'

        syncRegexScriptGroup(group)

        expect(output).toEqual({ ...input, type: 'editoutput' })
    })

    test('removes and reorders whole logical groups', () => {
        const firstInput = script('editinput', { comment: 'first' })
        const secondInput = script('editinput', { comment: 'second' })
        const firstOutput = script('editoutput', { comment: 'first' })
        const scripts = [firstInput, secondInput, firstOutput]
        const groups = groupRegexScripts(scripts)

        expect(removeRegexScriptGroup(scripts, groups[0])).toEqual([secondInput])
        expect(reorderRegexScriptGroups(groups, [1, 0])).toEqual([
            secondInput,
            firstInput,
            firstOutput,
        ])
    })
})

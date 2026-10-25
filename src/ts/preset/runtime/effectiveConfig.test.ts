import { describe, expect, test } from 'vitest'
import type { ModelPreset, RegistryUiField } from '../types'
import { getEffectivePresetValue } from './effectiveConfig'

function preset(value: unknown, widget: RegistryUiField['widget'] = 'select') {
    return {
        profileSnapshot: {
            schema: [{
                key: 'choice',
                type: 'string',
                label: 'Choice',
                default: 'low',
                enum: [
                    { value: 'low', label: 'Low' },
                    { value: 2, label: 'Two' },
                ],
            }],
            uiSchema: { groups: [], fields: [{ key: 'choice', widget }] },
        },
        userValues: { choice: value },
    } as unknown as Pick<ModelPreset, 'profileSnapshot' | 'userValues'>
}

describe('getEffectivePresetValue', () => {
    test.each([
        ['a choice the field no longer offers', preset('budget'), 'low'],
        ['a segmented choice the field no longer offers', preset('budget', 'segmented'), 'low'],
        ['Disabled', preset(''), ''],
        ['a select-stored numeric option', preset('2'), '2'],
        ['free combobox text', preset('custom-id', 'combobox'), 'custom-id'],
        ['free text input', preset('xhigh', 'text'), 'xhigh'],
    ])('resolves %s', (_label, value, expected) => {
        expect(getEffectivePresetValue(value, 'choice')).toBe(expected)
    })
})

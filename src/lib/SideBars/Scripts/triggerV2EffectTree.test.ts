import { describe, expect, test } from 'vitest';
import type { triggerEffect, triggerEffectV2 } from 'src/ts/process/triggers';
import {
    appendTriggerV2Effect,
    getTriggerV2BlockRange,
    getTriggerV2ElseBlock,
    moveTriggerV2Effect,
    removeTriggerV2Effect,
    toggleTriggerV2Else,
} from './triggerV2EffectTree';

const effect = (type: string, indent = 0, fields: Record<string, unknown> = {}) => ({
    type,
    indent,
    ...fields,
}) as triggerEffectV2;

const shape = (effects: triggerEffect[]) => effects.map((item) => ({
    type: item.type,
    indent: (item as triggerEffectV2).indent,
}));

describe('Trigger V2 effect tree', () => {
    test('appends block effects with their structural terminator', () => {
        const next = appendTriggerV2Effect([], effect('v2IfAdvanced'));

        expect(shape(next)).toEqual([
            { type: 'v2IfAdvanced', indent: 0 },
            { type: 'v2EndIndent', indent: 1 },
        ]);
    });

    test('adds and removes an else branch without changing the if body', () => {
        const initial = [
            effect('v2IfAdvanced', 0),
            effect('v2SetVar', 1),
            effect('v2EndIndent', 1),
        ];
        const withElse = toggleTriggerV2Else(initial, 0, true);

        expect(shape(withElse)).toEqual([
            { type: 'v2IfAdvanced', indent: 0 },
            { type: 'v2SetVar', indent: 1 },
            { type: 'v2EndIndent', indent: 1 },
            { type: 'v2Else', indent: 0 },
            { type: 'v2EndIndent', indent: 1 },
        ]);
        expect(getTriggerV2ElseBlock(withElse, 0)).toEqual({
            endIndentIndex: 2,
            elseIndex: 3,
            elseEndIndex: 4,
        });
        expect(toggleTriggerV2Else(withElse, 0, false)).toEqual(initial);
    });

    test('removes a control block while preserving and unindenting its bodies', () => {
        const effects = [
            effect('v2IfAdvanced', 0),
            effect('v2SetVar', 1),
            effect('v2EndIndent', 1),
            effect('v2Else', 0),
            effect('v2ConsoleLog', 1),
            effect('v2EndIndent', 1),
            effect('v2StopTrigger', 0),
        ];

        expect(shape(removeTriggerV2Effect(effects, 0))).toEqual([
            { type: 'v2SetVar', indent: 0 },
            { type: 'v2ConsoleLog', indent: 0 },
            { type: 'v2StopTrigger', indent: 0 },
        ]);
        expect(shape(effects)).toEqual([
            { type: 'v2IfAdvanced', indent: 0 },
            { type: 'v2SetVar', indent: 1 },
            { type: 'v2EndIndent', indent: 1 },
            { type: 'v2Else', indent: 0 },
            { type: 'v2ConsoleLog', indent: 1 },
            { type: 'v2EndIndent', indent: 1 },
            { type: 'v2StopTrigger', indent: 0 },
        ]);
    });

    test('moves an entire conditional including its else branch', () => {
        const effects = [
            effect('v2IfAdvanced', 0),
            effect('v2SetVar', 1),
            effect('v2EndIndent', 1),
            effect('v2Else', 0),
            effect('v2ConsoleLog', 1),
            effect('v2EndIndent', 1),
            effect('v2StopTrigger', 0),
        ];

        expect(getTriggerV2BlockRange(effects, 0)).toEqual({ start: 0, end: 5 });
        expect(shape(moveTriggerV2Effect(effects, 0, effects.length))).toEqual([
            { type: 'v2StopTrigger', indent: 0 },
            { type: 'v2IfAdvanced', indent: 0 },
            { type: 'v2SetVar', indent: 1 },
            { type: 'v2EndIndent', indent: 1 },
            { type: 'v2Else', indent: 0 },
            { type: 'v2ConsoleLog', indent: 1 },
            { type: 'v2EndIndent', indent: 1 },
        ]);
        expect(shape(effects)).toEqual([
            { type: 'v2IfAdvanced', indent: 0 },
            { type: 'v2SetVar', indent: 1 },
            { type: 'v2EndIndent', indent: 1 },
            { type: 'v2Else', indent: 0 },
            { type: 'v2ConsoleLog', indent: 1 },
            { type: 'v2EndIndent', indent: 1 },
            { type: 'v2StopTrigger', indent: 0 },
        ]);
    });

    test('does not move a block into itself', () => {
        const effects = [
            effect('v2LoopNTimes', 0),
            effect('v2ConsoleLog', 1),
            effect('v2EndIndent', 1),
        ];

        expect(moveTriggerV2Effect(effects, 0, 2)).toBe(effects);
    });
});

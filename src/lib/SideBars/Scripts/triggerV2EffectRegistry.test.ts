import { describe, expect, test } from 'vitest';
import { createTriggerV2Effect, effectCategories } from './triggerV2EffectRegistry';

describe('Trigger V2 effect registry', () => {
    test('creates a matching default object for every listed effect', () => {
        const listedEffects = Object.values(effectCategories).flat();

        expect(listedEffects).not.toHaveLength(0);
        for (const type of listedEffects) {
            expect(createTriggerV2Effect(type)?.type, type).toBe(type);
        }
    });

    test('returns null for unknown effect types', () => {
        expect(createTriggerV2Effect('v2Unknown')).toBeNull();
    });

    test('lists every Lorebook V2 effect', () => {
        expect(effectCategories['Lorebook V2']).toEqual([
            'v2GetAllLorebooks',
            'v2GetLorebookByName',
            'v2GetLorebookByIndex',
            'v2CreateLorebook',
            'v2ModifyLorebookByIndex',
            'v2DeleteLorebookByIndex',
            'v2GetLorebookCountNew',
            'v2SetLorebookAlwaysActive',
        ]);
    });
});

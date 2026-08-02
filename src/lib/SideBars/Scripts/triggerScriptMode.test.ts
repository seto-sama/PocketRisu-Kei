import { describe, expect, test } from 'vitest';
import type { triggerscript } from 'src/ts/storage/database.svelte';
import { getTriggerScriptMode } from './triggerScriptMode';

const scripts = (effectType?: string) => effectType
    ? [{ comment: '', type: 'manual', conditions: [], effect: [{ type: effectType }] }] as triggerscript[]
    : [];

describe('trigger script mode detection', () => {
    test('detects persisted Trigger V2 data before loading its editor', () => {
        expect(getTriggerScriptMode(scripts('v2Header'))).toBe('v2');
    });

    test('detects Lua data', () => {
        expect(getTriggerScriptMode(scripts('triggerlua'))).toBe('lua');
    });

    test('keeps empty and legacy trigger arrays in V1 mode', () => {
        expect(getTriggerScriptMode([])).toBe('v1');
        expect(getTriggerScriptMode(scripts('setvar'))).toBe('v1');
    });

    test('preserves the legacy code-mode distinction', () => {
        expect(getTriggerScriptMode(scripts('triggercode'))).toBe('v1code');
    });
});

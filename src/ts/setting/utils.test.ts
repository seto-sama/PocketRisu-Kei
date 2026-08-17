import { describe, expect, it } from 'vitest';
import { DBState } from '../stores.svelte';
import type { SettingContext, SettingItem } from './types';
import { getSettingValue, setSettingValue } from './utils';

function createContext(target?: object): SettingContext {
    return {
        db: DBState.db,
        target,
    };
}

describe('setting binding target', () => {
    it('uses target as the bindKey root', () => {
        const target = { username: 'before' };
        const item: SettingItem = { id: 'target.key', type: 'text', bindKey: 'username' };
        const ctx = createContext(target);

        expect(getSettingValue(item, ctx)).toBe('before');
        setSettingValue(item, 'after', ctx);
        expect(target.username).toBe('after');
    });

    it('reads and creates nested bindPath values on target', () => {
        const target: { promptCaching?: { ttlSec?: number } } = {};
        const item: SettingItem = {
            id: 'target.path',
            type: 'number',
            bindPath: 'promptCaching.ttlSec',
            options: { defaultValue: 600 },
        };
        const ctx = createContext(target);

        expect(getSettingValue(item, ctx)).toBe(600);
        setSettingValue(item, 900, ctx);
        expect(target.promptCaching).toEqual({ ttlSec: 900 });
        expect(getSettingValue(item, ctx)).toBe(900);
    });

    it('falls back to DBState.db when target is omitted', () => {
        const item: SettingItem = { id: 'default.target', type: 'text', bindKey: 'username' };
        const ctx = createContext();
        const previous = DBState.db.username;

        try {
            setSettingValue(item, 'default-target-test', ctx);
            expect(DBState.db.username).toBe('default-target-test');
            expect(getSettingValue(item, ctx)).toBe('default-target-test');
        } finally {
            DBState.db.username = previous;
        }
    });

    it('keeps custom accessors on the legacy DBState.db contract', () => {
        const target = { value: 'target' };
        let getterRoot: object | undefined;
        let setterRoot: object | undefined;
        const item: SettingItem = {
            id: 'custom.accessor',
            type: 'text',
            getValue: (db) => { getterRoot = db; return 'custom'; },
            setValue: (db) => { setterRoot = db; },
        };
        const ctx = createContext(target);

        expect(getSettingValue(item, ctx)).toBe('custom');
        setSettingValue(item, 'next', ctx);
        expect(getterRoot).toBe(DBState.db);
        expect(setterRoot).toBe(DBState.db);
    });
});

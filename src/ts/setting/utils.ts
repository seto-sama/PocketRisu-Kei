import type { SettingItem, SettingContext } from './types';
import { DBState } from '../stores.svelte';
import { language } from 'src/lang';

/**
 * Sentinel value representing an uninitialized local state in wrapper components.
 * Used instead of `undefined` so that a legitimate `undefined` DB value
 * can still be written back without being silently ignored.
 */
export const UNINITIALIZED = Symbol('uninitialized');

export function getLabel(item: SettingItem): string {
    if (item.labelKey && (language as any)[item.labelKey]) {
        return (language as any)[item.labelKey];
    }
    return item.fallbackLabel ?? '';
}

export function getSettingValue(item: SettingItem, ctx: SettingContext): any {
    if (item.getValue) {
        return item.getValue(DBState.db, ctx);
    }
    const root: any = ctx.target ?? DBState.db;
    if (item.bindPath) {
        const parts = item.bindPath.split('.');
        let value: any = root;
        for (const part of parts) {
            value = value?.[part];
        }
        return value === undefined ? item.options?.defaultValue : value;
    }
    if (item.bindKey) {
        const value = root[item.bindKey];
        return value === undefined ? item.options?.defaultValue : value;
    }
    return undefined;
}

export function setSettingValue(item: SettingItem, newValue: any, ctx: SettingContext): void {
    if (item.setValue) {
        item.setValue(DBState.db, newValue, ctx);
    } else if (item.bindPath) {
        const root: any = ctx.target ?? DBState.db;
        const parts = item.bindPath.split('.');
        let obj: any = root;
        for (let i = 0; i < parts.length - 1; i++) {
            obj = obj[parts[i]] ??= {};
        }
        obj[parts[parts.length - 1]] = newValue;
    } else if (item.bindKey) {
        const root: any = ctx.target ?? DBState.db;
        root[item.bindKey] = newValue;
    }
    
    if (item.onChange) {
        item.onChange(newValue, ctx);
    }
}

/**
 * Check if item should be visible based on condition
 */
export function checkCondition(item: SettingItem, ctx: SettingContext): boolean {
    if (!item.condition) return true;
    return item.condition(ctx);
}

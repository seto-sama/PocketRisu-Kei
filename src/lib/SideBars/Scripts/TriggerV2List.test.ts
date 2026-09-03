import { afterEach, describe, expect, test } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import TriggerV2List from './TriggerV2List.svelte';
import type { triggerscript } from 'src/ts/process/triggers';
import { language } from 'src/lang';

const mounted: ReturnType<typeof mount>[] = [];

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)));
    document.body.innerHTML = '';
});

describe('Trigger V2 effect picker', () => {
    test('renders every Lorebook V2 action in the action select', async () => {
        const target = document.createElement('div');
        document.body.appendChild(target);
        const value: triggerscript[] = [
            {
                comment: '',
                type: 'manual',
                conditions: [],
                effect: [{ type: 'v2Header', code: '', indent: 0 }],
            },
            {
                comment: 'Test event',
                type: 'manual',
                conditions: [],
                effect: [],
            },
        ];

        mounted.push(mount(TriggerV2List, { target, props: { value } }));
        await tick();

        const trigger = target.querySelector<HTMLElement>('[data-trigger-v2-index="1"]');
        trigger?.querySelector<HTMLElement>('[data-disclosure-toggle]')?.click();
        await tick();
        trigger?.querySelector<HTMLButtonElement>(`button[aria-label="${language.add}"]`)?.click();
        await tick();

        const categorySelect = Array.from(trigger?.querySelectorAll<HTMLSelectElement>('select') ?? [])
            .find(select => Array.from(select.options).some(option => option.textContent?.trim() === 'Lorebook V2'));
        const categoryPicker = categorySelect?.parentElement?.querySelector<HTMLElement>('[data-slot="select-trigger"]');
        expect(categoryPicker).toBeTruthy();
        categoryPicker!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await tick();
        const lorebookOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
            .find(option => option.textContent?.trim() === 'Lorebook V2');
        expect(lorebookOption).toBeTruthy();
        lorebookOption!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await tick();

        const actionSelect = Array.from(trigger?.querySelectorAll<HTMLSelectElement>('select') ?? [])
            .find(select => Array.from(select.options).some(option => option.value === 'v2GetAllLorebooks'));
        expect(Array.from(actionSelect?.options ?? []).map(option => option.value)).toEqual([
            '',
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

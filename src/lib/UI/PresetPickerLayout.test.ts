import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Harness from './PresetPickerHarness.test.svelte';
import { language } from 'src/lang';

vi.mock('src/ts/alert', () => ({
    alertConfirm: vi.fn(async () => true),
    alertConfirmMulti: vi.fn(async () => 0),
    alertInput: vi.fn(),
}));
vi.mock('src/ts/util', () => ({ sortableOptions: {} }));
vi.mock('src/ts/parser/parser.svelte', () => ({ parseMarkdownSafe: (text: string) => text }));

const mounted: ReturnType<typeof mount>[] = [];
afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)));
    document.body.innerHTML = '';
});

async function search(query: string) {
    const input = document.querySelector<HTMLInputElement>('section input')!;
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
}

describe('preset picker binding choice', () => {
    it('filters none by search and category and suppresses empty notices when it is available', async () => {
        const onSelect = vi.fn();
        const onSelectNone = vi.fn();
        mounted.push(mount(Harness, { target: document.body, props: { onSelect, onSelectNone } }));
        await tick();

        const none = document.querySelector<HTMLButtonElement>('[data-preset-select-none]')!;
        expect(none).toBeTruthy();
        expect(none.parentElement!.lastElementChild).toBe(none);
        expect(none.hasAttribute('data-sortable-key')).toBe(false);
        expect(none.getAttribute('data-selected')).toBe('true');

        await search('no-match');
        expect(document.querySelector('.preset-picker-item')).toBeNull();
        expect(document.querySelector('[data-preset-select-none]')).toBeNull();
        expect(document.querySelector('[data-slot="empty-state"]')).toBeTruthy();
        expect(onSelect).not.toHaveBeenCalled();

        await search('  바인딩  ');
        expect(document.querySelector('.preset-picker-item')).toBeNull();
        expect(document.querySelector('[data-slot="empty-state"]')).toBeNull();
        document.querySelector<HTMLButtonElement>('[data-preset-select-none]')!.click();
        expect(onSelectNone).toHaveBeenCalledOnce();

        await search('');
        const folder = Array.from(document.querySelectorAll<HTMLElement>('aside [role="button"]'))
            .find(element => element.textContent?.includes('Empty folder'))!;
        folder.click();
        await tick();
        expect(document.querySelector('.preset-picker-item')).toBeNull();
        expect(document.querySelector('[data-preset-select-none]')).toBeNull();
        expect(document.querySelector('[data-slot="empty-state"]')).toBeTruthy();

        await search('바인딩');
        expect(document.querySelector('[data-preset-select-none]')).toBeNull();

        const uncategorized = Array.from(document.querySelectorAll<HTMLButtonElement>('aside button'))
            .find(element => element.textContent?.includes(language.presetUncategorized))!;
        uncategorized.click();
        await tick();
        expect(document.querySelector('[data-preset-select-none]')).toBeTruthy();
        expect(document.querySelector('[data-slot="empty-state"]')).toBeNull();

        await search('no-match');
        expect(document.querySelector('[data-preset-select-none]')).toBeNull();
        expect(document.querySelector('[data-slot="empty-state"]')).toBeTruthy();
    });

    it('shows only none when no presets exist', async () => {
        mounted.push(mount(Harness, { target: document.body, props: { names: [], onSelectNone: vi.fn() } }));
        await tick();
        const none = document.querySelector('[data-preset-select-none]')!;
        expect(none).toBeTruthy();
        expect(document.querySelector('[data-slot="empty-state"]')).toBeNull();
        expect(none.parentElement!.firstElementChild).toBe(none);
        expect(none.parentElement!.lastElementChild).toBe(none);
    });

    it('keeps normal selection and delete actions separate and omits none outside binding mode', async () => {
        const onSelect = vi.fn();
        const onDelete = vi.fn();
        const onDuplicate = vi.fn();
        mounted.push(mount(Harness, { target: document.body, props: { onSelect, onDelete, onDuplicate } }));
        await tick();
        expect(document.querySelector('[data-preset-select-none]')).toBeNull();
        const row = document.querySelector<HTMLElement>('.preset-picker-item')!;
        row.querySelector<HTMLButtonElement>(`button[aria-label="${language.presetDuplicate}"]`)!.click();
        expect(onDuplicate).toHaveBeenCalledWith(0);
        expect(onSelect).not.toHaveBeenCalled();
        row.querySelector<HTMLButtonElement>(`button[aria-label="${language.presetDeleteAction}"]`)!.click();
        await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith(0));
        expect(onSelect).not.toHaveBeenCalled();
        row.click();
        expect(onSelect).toHaveBeenCalledWith(0);
    });
});

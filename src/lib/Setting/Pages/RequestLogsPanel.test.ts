import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import RequestLogsPanel from './RequestLogsPanel.svelte';
import { getServerFetchLogs } from 'src/ts/globalApi.svelte';
import type { FetchLogPage } from 'src/ts/requestLogStore';
import { language } from 'src/lang';

// Keep network and notification services isolated from application startup effects.
vi.mock('src/ts/globalApi.svelte', () => ({
    getServerFetchLogs: vi.fn(),
    getServerFetchLogById: vi.fn(),
    clearFetchLogs: vi.fn(),
    clearServerFetchLogs: vi.fn(),
    deleteFetchLog: vi.fn(),
    deleteServerFetchLog: vi.fn(),
}));
vi.mock('src/ts/alert', () => ({
    alertConfirm: vi.fn(),
    notifyError: vi.fn(),
    notifySuccess: vi.fn(),
}));

const mounted: ReturnType<typeof mount>[] = [];
const page: FetchLogPage = {
    content: [{
        id: 'request-1',
        success: true,
        date: '2026-09-06',
        timestamp: 1788652800000,
        url: 'https://example.test/chat',
        model: 'Visible model',
    }],
    total: 2,
};

beforeEach(() => {
    vi.mocked(getServerFetchLogs).mockReset();
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)));
    document.body.innerHTML = '';
});

async function renderPanel() {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(RequestLogsPanel, { target }));
    await tick();
    return target;
}

async function search(target: HTMLElement, query: string) {
    const input = target.querySelector<HTMLInputElement>('input')!;
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
}

describe('request log empty states', () => {
    test('shows one search explanation, preserves pagination, and restores results when cleared', async () => {
        vi.mocked(getServerFetchLogs).mockResolvedValue(page);
        const target = await renderPanel();
        await vi.waitFor(() => expect(target.textContent).toContain('Visible model'));

        await search(target, 'unmatched-query');
        const empty = target.querySelector('[data-slot="empty-state"]');
        expect(empty?.textContent).toContain(language.noSearchResults);
        expect(target.textContent?.split(language.noSearchResultsDesc)).toHaveLength(2);
        expect(target.textContent).not.toContain(language.noRequestLogs);
        expect(target.textContent).not.toContain(language.requestLogsEmptyDesc);
        expect(target.textContent).not.toContain(language.systemLogsEmptyButMore);
        expect(Array.from(target.querySelectorAll('button')).some(button =>
            button.textContent?.includes(language.systemLogsLoadMore))).toBe(true);

        await search(target, '   ');
        expect(target.querySelector('[data-slot="empty-state"]')).toBeNull();
        expect(target.textContent).toContain('Visible model');
    });

    test('distinguishes an empty store from an empty search', async () => {
        vi.mocked(getServerFetchLogs).mockResolvedValue({ content: [], total: 0 });
        const target = await renderPanel();
        await vi.waitFor(() => expect(target.textContent).toContain(language.noRequestLogs));
        expect(target.textContent).toContain(language.requestLogsEmptyDesc);
        expect(target.textContent).not.toContain(language.noSearchResultsDesc);

        await search(target, 'query');
        expect(target.textContent).toContain(language.noSearchResultsDesc);
        expect(target.textContent).not.toContain(language.requestLogsEmptyDesc);
    });

    test('does not claim the log is empty while loading or after a load error', async () => {
        let rejectLoad!: (reason: Error) => void;
        vi.mocked(getServerFetchLogs).mockReturnValue(new Promise((_, reject) => {
            rejectLoad = reject;
        }));
        const target = await renderPanel();
        expect(target.querySelector('[data-slot="empty-state"]')).toBeNull();

        rejectLoad(new Error('Test load failure'));
        await vi.waitFor(() => expect(target.textContent).toContain('Test load failure'));
        expect(target.querySelector('[data-slot="empty-state"]')).toBeNull();
    });
});

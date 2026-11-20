import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import RequestLogsPanel from './RequestLogsPanel.svelte';
import {
    clearFetchLogs,
    clearServerFetchLogs,
    getServerFetchLogById,
    getServerFetchLogs,
} from 'src/ts/globalApi.svelte';
import type { FetchLog, FetchLogPage } from 'src/ts/requestLogStore';
import { language } from 'src/lang';
import { alertConfirm, alertConfirmMulti, notifyError } from 'src/ts/alert';

// Keep network and notification services isolated from application startup effects.
vi.mock('src/ts/globalApi.svelte', () => ({
    getServerFetchLogs: vi.fn(),
    getServerFetchLogById: vi.fn(),
    clearFetchLogs: vi.fn(),
    clearServerFetchLogs: vi.fn(),
    deleteFetchLog: vi.fn(),
    deleteServerFetchLog: vi.fn(),
}));
vi.mock('src/ts/clipboard/keiClipboard.svelte', () => ({ writeSystemClipboard: vi.fn() }));
vi.mock('src/ts/alert', () => ({
    alertConfirm: vi.fn(),
    alertConfirmMulti: vi.fn(),
    notifyError: vi.fn(),
    notifySuccess: vi.fn(),
}));

const mounted: ReturnType<typeof mount>[] = [];
const defaultStorage = {
    currentBytes: 2 * 1024 ** 2,
    maxBytes: 256 * 1024 ** 2,
    minBytes: 1024 ** 2,
};
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
    storage: defaultStorage,
};

beforeEach(() => {
    vi.mocked(getServerFetchLogs).mockReset();
    vi.mocked(getServerFetchLogById).mockReset();
    vi.mocked(alertConfirmMulti).mockReset();
    vi.mocked(alertConfirm).mockReset().mockResolvedValue(true);
    vi.mocked(notifyError).mockReset();
    vi.mocked(clearFetchLogs).mockReset();
    vi.mocked(clearServerFetchLogs).mockReset();
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
    const input = target.querySelector<HTMLInputElement>('input[type="text"]')!;
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
}

async function clickClearRequestLogs(target: HTMLElement) {
    const button = Array.from(target.querySelectorAll('button')).find(button =>
        button.textContent?.includes(language.systemLogsClearAll));
    expect(button).toBeDefined();
    button!.click();
    await tick();
}

describe('request log empty states', () => {
    test('shows retained metadata when the payload has been evicted', async () => {
        vi.mocked(getServerFetchLogs).mockResolvedValue(page);
        vi.mocked(getServerFetchLogById).mockResolvedValue({
            ...page.content[0],
            body: '',
            header: '',
            response: '',
            payloadAvailable: false,
        } satisfies FetchLog);

        const target = await renderPanel();
        await vi.waitFor(() => expect(target.textContent).toContain('Visible model'));
        const row = Array.from(target.querySelectorAll('button')).find(button =>
            button.textContent?.includes('Visible model'));
        expect(row).toBeDefined();
        row!.click();

        await vi.waitFor(() => expect(target.textContent).toContain(language.requestDiagnostics.noRequestLogDesc));
        expect(target.textContent).toContain('https://example.test/chat');
        expect(target.textContent).toContain(language.systemLogsDeleteEntry);
        expect(target.textContent).not.toContain(language.systemLogsCopyEntry);
    });

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
        vi.mocked(getServerFetchLogs).mockResolvedValue({ content: [], total: 0, storage: defaultStorage });
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

describe('request log clearing', () => {
    test('deletes payloads only and reloads retained metadata', async () => {
        let finishClear!: () => void;
        vi.mocked(clearServerFetchLogs).mockReturnValue(new Promise<void>(resolve => {
            finishClear = resolve;
        }));
        vi.mocked(getServerFetchLogs).mockResolvedValueOnce(page).mockResolvedValueOnce(page);
        vi.mocked(alertConfirmMulti).mockResolvedValue(0);
        const target = await renderPanel();
        await vi.waitFor(() => expect(target.textContent).toContain('Visible model'));

        await clickClearRequestLogs(target);

        await vi.waitFor(() => expect(clearServerFetchLogs).toHaveBeenCalledWith('payload'));
        expect(clearFetchLogs).not.toHaveBeenCalled();
        expect(getServerFetchLogs).toHaveBeenCalledOnce();
        finishClear();

        await vi.waitFor(() => expect(getServerFetchLogs).toHaveBeenCalledTimes(2));
        expect(alertConfirmMulti).toHaveBeenCalledWith(language.systemLogsClearAll, [
            { label: language.requestLogsClearPayload, variant: 'destructive' },
            { label: language.requestLogsClearAll, variant: 'destructive' },
        ]);
        expect(alertConfirm).toHaveBeenCalledWith(language.requestLogsClearPayloadConfirm);
        expect(clearFetchLogs).toHaveBeenCalledWith('payload');
        expect(target.textContent).toContain('Visible model');
    });

    test('deletes metadata too and reloads an empty list', async () => {
        vi.mocked(getServerFetchLogs)
            .mockResolvedValueOnce(page)
            .mockResolvedValueOnce({ content: [], total: 0, storage: defaultStorage });
        vi.mocked(alertConfirmMulti).mockResolvedValue(1);
        const target = await renderPanel();
        await vi.waitFor(() => expect(target.textContent).toContain('Visible model'));

        await clickClearRequestLogs(target);

        await vi.waitFor(() => expect(target.textContent).toContain(language.noRequestLogs));
        expect(getServerFetchLogs).toHaveBeenCalledTimes(2);
        expect(clearServerFetchLogs).toHaveBeenCalledWith('all');
        expect(alertConfirm).toHaveBeenCalledWith(language.requestLogsClearConfirm);
        expect(clearFetchLogs).toHaveBeenCalledWith('all');
    });

    test('does not delete anything when the choice dialog is cancelled', async () => {
        vi.mocked(getServerFetchLogs).mockResolvedValue(page);
        vi.mocked(alertConfirmMulti).mockResolvedValue(-1);
        const target = await renderPanel();
        await vi.waitFor(() => expect(target.textContent).toContain('Visible model'));

        await clickClearRequestLogs(target);
        await vi.waitFor(() => expect(alertConfirmMulti).toHaveBeenCalledOnce());
        await tick();

        expect(clearServerFetchLogs).not.toHaveBeenCalled();
        expect(alertConfirm).not.toHaveBeenCalled();
        expect(clearFetchLogs).not.toHaveBeenCalled();
        expect(getServerFetchLogs).toHaveBeenCalledOnce();
        expect(target.textContent).toContain('Visible model');
    });

    test.each([
        { selection: 0, confirmation: language.requestLogsClearPayloadConfirm },
        { selection: 1, confirmation: language.requestLogsClearConfirm },
    ])('does not delete anything when final confirmation is cancelled for selection $selection', async ({ selection, confirmation }) => {
        vi.mocked(getServerFetchLogs).mockResolvedValue(page);
        vi.mocked(alertConfirmMulti).mockResolvedValue(selection);
        vi.mocked(alertConfirm).mockResolvedValue(false);
        const target = await renderPanel();
        await vi.waitFor(() => expect(target.textContent).toContain('Visible model'));

        await clickClearRequestLogs(target);
        await vi.waitFor(() => expect(alertConfirm).toHaveBeenCalledWith(confirmation));
        await tick();

        expect(clearServerFetchLogs).not.toHaveBeenCalled();
        expect(clearFetchLogs).not.toHaveBeenCalled();
        expect(getServerFetchLogs).toHaveBeenCalledOnce();
        expect(target.textContent).toContain('Visible model');
    });

    test('ignores a detail response that arrives after a clear and reload', async () => {
        let resolveOldDetail!: (detail: FetchLog) => void;
        const oldDetail = new Promise<FetchLog>(resolve => {
            resolveOldDetail = resolve;
        });
        const evictedDetail: FetchLog = {
            ...page.content[0],
            body: '',
            header: '',
            response: '',
            payloadAvailable: false,
        };
        vi.mocked(getServerFetchLogs).mockResolvedValueOnce(page).mockResolvedValueOnce(page);
        vi.mocked(getServerFetchLogById)
            .mockReturnValueOnce(oldDetail)
            .mockResolvedValueOnce(evictedDetail);
        vi.mocked(alertConfirmMulti).mockResolvedValue(0);

        const target = await renderPanel();
        await vi.waitFor(() => expect(target.textContent).toContain('Visible model'));
        const clickLogRow = () => {
            const row = Array.from(target.querySelectorAll('button')).find(button =>
                button.textContent?.includes('Visible model'));
            expect(row).toBeDefined();
            row!.click();
        };
        clickLogRow();
        await vi.waitFor(() => expect(getServerFetchLogById).toHaveBeenCalledOnce());

        await clickClearRequestLogs(target);
        await vi.waitFor(() => expect(getServerFetchLogs).toHaveBeenCalledTimes(2));

        clickLogRow();
        await vi.waitFor(() => expect(target.textContent).toContain(language.requestDiagnostics.noRequestLogDesc));
        expect(getServerFetchLogById).toHaveBeenCalledTimes(2);

        resolveOldDetail({
            ...page.content[0],
            body: 'old request payload',
            header: 'old request headers',
            response: 'old response payload',
            payloadAvailable: true,
        });
        await oldDetail;
        await tick();

        expect(target.textContent).toContain(language.requestDiagnostics.noRequestLogDesc);
        expect(target.textContent).not.toContain('old request payload');
        expect(target.textContent).not.toContain('old response payload');
        expect(target.textContent).not.toContain(language.systemLogsCopyEntry);
    });
});

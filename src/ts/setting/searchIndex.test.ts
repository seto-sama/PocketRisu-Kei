import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { SettingsRoute } from '../routing';
import { DBState, LanguageSubmenuIndex, SettingsMenuIndex, settingsOpen } from '../stores.svelte';
import { navigateToSearchResult, searchSettings } from './searchIndex';

describe('settings search', () => {
    it('indexes declarative setting keywords with their tab target', () => {
        const result = searchSettings('regenerate', { db: DBState.db })
            .find((entry) => entry.itemId === 'acc.confirmReroll');

        expect(result).toMatchObject({
            route: SettingsRoute.Accessibility,
            subTab: 0,
            rank: 1,
        });
    });

    it('indexes hardcoded sub-tabs from the manifest', () => {
        const result = searchSettings('translation cache', { db: DBState.db })[0];

        expect(result).toMatchObject({
            key: 'manual.language.cache',
            route: SettingsRoute.Language,
            subTab: 1,
        });
    });

    it('opens settings and selects the result sub-tab', () => {
        navigateToSearchResult({
            key: 'test.language.cache',
            label: 'Translation Cache',
            location: 'Language',
            route: SettingsRoute.Language,
            subTab: 1,
            rank: 0,
        });

        expect(get(settingsOpen)).toBe(true);
        expect(get(SettingsMenuIndex)).toBe(SettingsRoute.Language);
        expect(get(LanguageSubmenuIndex)).toBe(1);
    });
});

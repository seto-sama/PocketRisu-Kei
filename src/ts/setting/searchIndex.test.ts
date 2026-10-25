import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { ModelPresetTab, openSettings, SettingsRoute } from '../routing';
import { DBState, LanguageSubmenuIndex, ModelPresetListTabIndex, SettingsMenuIndex, settingsOpen } from '../stores.svelte';
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

    it('opens settings on the sub-tab of a manifest search result', () => {
        navigateToSearchResult(searchSettings('translation cache', { db: DBState.db })[0]);

        expect(get(settingsOpen)).toBe(true);
        expect(get(SettingsMenuIndex)).toBe(SettingsRoute.Language);
        expect(get(LanguageSubmenuIndex)).toBe(1);
    });

    it('deep-links to model preset options through the shared router', () => {
        openSettings(
            SettingsRoute.ModelPreset,
            undefined,
            undefined,
            ModelPresetTab.Options,
        );

        expect(get(SettingsMenuIndex)).toBe(SettingsRoute.ModelPreset);
        expect(get(ModelPresetListTabIndex)).toBe(ModelPresetTab.Options);
    });
});

import type { Writable } from 'svelte/store';
import { language } from 'src/lang';
import { languageEnglish } from 'src/lang/en';
import { SettingsRoute, openSettings, type SettingsRouteValue } from '../routing';
import {
    AccessibilitySubmenuIndex,
    AddonSubmenuIndex,
    AdminStatsSubmenuIndex,
    AdvancedSubmenuIndex,
    DisplaySubmenuIndex,
    InlayGallerySubmenuIndex,
    LanguageSubmenuIndex,
    ModelPresetListTabIndex,
    OtherBotsSubmenuIndex,
    PromptPresetSubmenuIndex,
    SystemSubmenuIndex,
} from '../stores.svelte';
import type { SettingContext, SettingItem } from './types';
import { checkCondition, getLabel } from './utils';
import {
    displayOtherAdvancedItems,
    displayOtherChatItems,
    displayOtherHomeItems,
    displayOtherQuoteItems,
    displaySizeSettingsItems,
    displayThemeGeneralSettingsItems,
    displayThemePaletteSettingsItems,
} from './displaySettingsData.svelte';
import {
    accessibilityChatPanelItems,
    accessibilityEditingItems,
    accessibilityInputItems,
    accessibilityMenuBarItems,
    accessibilityOtherItems,
    accessibilityScrollItems,
} from './accessibilitySettingsData';
import { advancedSettingsItems } from './advancedSettingsData';
import { languageSettingsItems } from './languageSettingsData.svelte';
import { inlayImageSettingsItems } from './inlayImageSettingsData';
import { modelPresetOtherOptionsItems, modelPresetRegistryOptionsItems } from './modelPresetOptionsData';
import { promptPresetParameterItems, promptPresetPromptItems } from './promptPresetSettingsData.svelte';
import { searchManifestEntries } from './searchManifestData';

interface DeclarativeSource {
    items: SettingItem[];
    route: SettingsRouteValue;
    subTab?: number;
    tabLabel?: () => string;
    sectionLabel?: () => string;
}

const advancedRequestIds = new Set([
    'adv.retries', 'adv.genTime', 'adv.sayNothing', 'adv.autoFill', 'adv.antiOverload',
    'adv.exp.cachePoint', 'adv.toolUsage', 'adv.simpleTool', 'adv.banChar', 'adv.lbDepth',
    'adv.lbToken', 'adv.disableLbRecursive', 'adv.localActivationInCharacterLorebook', 'adv.bulkEnabling',
]);

const declarativeSources: DeclarativeSource[] = [
    { items: displayThemeGeneralSettingsItems, route: SettingsRoute.Display, subTab: 0, tabLabel: () => language.theme },
    { items: displayThemePaletteSettingsItems, route: SettingsRoute.Display, subTab: 0, tabLabel: () => language.theme, sectionLabel: () => language.colorScheme },
    { items: displaySizeSettingsItems, route: SettingsRoute.Display, subTab: 1, tabLabel: () => language.sizeAndSpeed },
    { items: displayOtherHomeItems, route: SettingsRoute.Display, subTab: 2, tabLabel: () => language.others, sectionLabel: () => language.sectionHomeList },
    { items: displayOtherChatItems, route: SettingsRoute.Display, subTab: 2, tabLabel: () => language.others, sectionLabel: () => language.sectionChatView },
    { items: displayOtherQuoteItems, route: SettingsRoute.Display, subTab: 2, tabLabel: () => language.others, sectionLabel: () => language.sectionQuotes },
    { items: displayOtherAdvancedItems, route: SettingsRoute.Display, subTab: 2, tabLabel: () => language.others, sectionLabel: () => language.sectionAdvanced },
    { items: accessibilityEditingItems, route: SettingsRoute.Accessibility, subTab: 0, tabLabel: () => language.accTabEditing },
    { items: accessibilityScrollItems, route: SettingsRoute.Accessibility, subTab: 1, tabLabel: () => language.accTabScroll },
    { items: [...accessibilityChatPanelItems, ...accessibilityInputItems, ...accessibilityMenuBarItems], route: SettingsRoute.Accessibility, subTab: 2, tabLabel: () => language.accTabSidebar },
    { items: accessibilityOtherItems, route: SettingsRoute.Accessibility, subTab: 4, tabLabel: () => language.others },
    { items: advancedSettingsItems.filter((item) => advancedRequestIds.has(item.id)), route: SettingsRoute.Advanced, subTab: 0, tabLabel: () => language.advancedRequestTab },
    { items: advancedSettingsItems.filter((item) => !advancedRequestIds.has(item.id)), route: SettingsRoute.Advanced, subTab: 1, tabLabel: () => language.others },
    { items: languageSettingsItems, route: SettingsRoute.Language, subTab: 0, tabLabel: () => language.generalSettings },
    { items: inlayImageSettingsItems, route: SettingsRoute.InlayImageGallery, subTab: 2, tabLabel: () => language.settings },
    { items: [...modelPresetOtherOptionsItems, ...modelPresetRegistryOptionsItems], route: SettingsRoute.ModelPreset, subTab: 2, tabLabel: () => language.modelPresetTabOptions },
    { items: promptPresetParameterItems, route: SettingsRoute.PromptPreset, subTab: 0, tabLabel: () => language.presetGeneral },
    { items: promptPresetPromptItems, route: SettingsRoute.PromptPreset, subTab: 1, tabLabel: () => language.prompt },
];

function routeLabel(route: SettingsRouteValue): string {
    switch (route) {
        case SettingsRoute.OtherBots: return language.otherBots;
        case SettingsRoute.Display: return language.soundAndDisplay;
        case SettingsRoute.Addons: return language.addons;
        case SettingsRoute.Files: return language.files;
        case SettingsRoute.Advanced: return language.advancedSettings;
        case SettingsRoute.Language: return language.language;
        case SettingsRoute.Accessibility: return language.accessibility;
        case SettingsRoute.Persona: return language.persona;
        case SettingsRoute.Prompt: return language.prompt;
        case SettingsRoute.ModelPreset: return language.modelPresetMenu;
        case SettingsRoute.PromptPreset: return language.promptPresetMenu;
        case SettingsRoute.RemoteAccess: return language.connectionManagement;
        case SettingsRoute.System: return language.storageManagement;
        case SettingsRoute.InlayImageGallery: return language.playground.inlayImageGallery;
        case SettingsRoute.AdminAndStats: return language.adminAndStats;
        default: return '';
    }
}

export interface SettingSearchResult {
    key: string;
    label: string;
    location: string;
    help?: string;
    route: SettingsRouteValue;
    subTab?: number;
    itemId?: string;
    rank: number;
}

function flattenItems(items: SettingItem[], ctx: SettingContext): SettingItem[] {
    const result: SettingItem[] = [];
    for (const item of items) {
        if (!checkCondition(item, ctx)) continue;
        if (item.type === 'accordion') {
            result.push(...flattenItems(item.options?.children ?? [], ctx));
        } else if (item.type !== 'header') {
            result.push(item);
        }
    }
    return result;
}

function localizedHelp(item: SettingItem): string | undefined {
    return item.helpKey ? (language.help as Record<string, string>)[item.helpKey] : item.description;
}

function rankMatch(query: string, labels: Array<string | undefined>, keywords: string[] | undefined, helps: Array<string | undefined>): number {
    if (labels.some((value) => value?.toLowerCase().includes(query))) return 0;
    if (keywords?.some((value) => value.toLowerCase().includes(query))) return 1;
    if (helps.some((value) => value?.toLowerCase().includes(query))) return 2;
    return -1;
}

export function searchSettings(rawQuery: string, ctx: SettingContext): SettingSearchResult[] {
    const query = rawQuery.trim().toLowerCase();
    if (!query) return [];
    const results: SettingSearchResult[] = [];

    for (const source of declarativeSources) {
        for (const item of flattenItems(source.items, ctx)) {
            const label = getLabel(item);
            if (!label) continue;
            const help = localizedHelp(item);
            const englishLabel = item.labelKey ? (languageEnglish as Record<string, unknown>)[item.labelKey] as string | undefined : undefined;
            const englishHelp = item.helpKey ? (languageEnglish.help as Record<string, string>)[item.helpKey] : undefined;
            const rank = rankMatch(query, [label, englishLabel], item.keywords, [help, englishHelp]);
            if (rank < 0) continue;
            results.push({
                key: `${source.route}:${source.subTab ?? ''}:${item.id}`,
                label,
                location: [routeLabel(source.route), source.tabLabel?.(), source.sectionLabel?.()].filter(Boolean).join(' · '),
                help,
                route: source.route,
                subTab: source.subTab,
                itemId: item.id,
                rank,
            });
        }
    }

    for (const entry of searchManifestEntries) {
        const label = entry.label();
        const help = entry.help?.();
        const rank = rankMatch(query, [label], entry.keywords, [help]);
        if (rank < 0) continue;
        const page = routeLabel(entry.route);
        results.push({ key: entry.id, label, location: page === label ? '' : page, help, route: entry.route, subTab: entry.subTab, rank });
    }

    return results.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)).slice(0, 30);
}

const submenuStores: Partial<Record<SettingsRouteValue, Writable<number>>> = {
    [SettingsRoute.Display]: DisplaySubmenuIndex,
    [SettingsRoute.Addons]: AddonSubmenuIndex,
    [SettingsRoute.Advanced]: AdvancedSubmenuIndex,
    [SettingsRoute.Language]: LanguageSubmenuIndex,
    [SettingsRoute.Accessibility]: AccessibilitySubmenuIndex,
    [SettingsRoute.OtherBots]: OtherBotsSubmenuIndex,
    [SettingsRoute.PromptPreset]: PromptPresetSubmenuIndex,
    [SettingsRoute.InlayImageGallery]: InlayGallerySubmenuIndex,
    [SettingsRoute.ModelPreset]: ModelPresetListTabIndex,
    [SettingsRoute.System]: SystemSubmenuIndex,
    [SettingsRoute.AdminAndStats]: AdminStatsSubmenuIndex,
};

export function navigateToSearchResult(result: SettingSearchResult): void {
    openSettings(result.route);
    if (result.subTab !== undefined) submenuStores[result.route]?.set(result.subTab);
    if (result.itemId) scrollToSettingAnchor(result.itemId);
}

function scrollToSettingAnchor(itemId: string, attempt = 0): void {
    if (typeof document === 'undefined') return;
    const escaped = globalThis.CSS?.escape ? CSS.escape(itemId) : itemId.replace(/["\\]/g, '\\$&');
    const element = document.querySelector<HTMLElement>(`[data-setting-id="${escaped}"]`);
    if (element) {
        element.scrollIntoView({ block: 'center' });
        element.animate?.([
            { boxShadow: '0 0 0 3px var(--risu-theme-primary, #fbbf24)' },
            { boxShadow: '0 0 0 3px transparent' },
        ], { duration: 1600, easing: 'ease-out' });
    } else if (attempt < 40) {
        requestAnimationFrame(() => scrollToSettingAnchor(itemId, attempt + 1));
    }
}

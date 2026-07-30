// Settings menu routing.
//
// `SettingsMenuIndex` is a numeric store consumed throughout
// `Settings.svelte`'s ~25 menu entries. Migrating to string IDs everywhere is
// a large refactor that touches every entry; instead this module exposes
// named constants for the existing numeric values so external callers can
// avoid magic numbers (and the bugs that come with reorderings).
//
// Add an entry here whenever a new settings page is added in
// `Settings.svelte`. Internal `Settings.svelte` switches still use the raw
// number — that file is the source of truth and changes there should update
// this map too.

import { AddonSubmenuIndex, settingsOpen, SettingsMenuIndex, SystemSubmenuIndex, AdminStatsSubmenuIndex, AccessibilitySubmenuIndex } from "./stores.svelte";

export const SettingsRoute = {
    None: -1 as const,
    Migration: 0 as const,
    OtherBots: 2 as const,
    SoundAndDisplay: 3 as const,
    Display: 3 as const,
    Addons: 4 as const,
    Files: 5 as const,
    Advanced: 6 as const,
    Language: 10 as const,
    Accessibility: 11 as const,
    Persona: 12 as const,
    Prompt: 13 as const,
    ModelPreset: 16 as const,
    PromptPreset: 17 as const,
    RemoteAccess: 21 as const,
    System: 22 as const,
    InlayImageGallery: 23 as const,
    AdminAndStats: 24 as const,
    DevPanel: 99 as const,
} as const;

export type SettingsRouteValue = (typeof SettingsRoute)[keyof typeof SettingsRoute];

/** Sub-tabs inside Add-ons. */
export const AddonSettingsTab = {
    Plugin: 0 as const,
    Module: 1 as const,
    MCP: 2 as const,
} as const;

export type AddonSettingsTabValue = (typeof AddonSettingsTab)[keyof typeof AddonSettingsTab];

/** Sub-tab indices inside Storage Management. */
export const StorageManagementTab = {
    Dashboard: 0 as const,
    Backups: 1 as const,
    PluginStorage: 2 as const,
} as const;

export type StorageManagementTabValue = (typeof StorageManagementTab)[keyof typeof StorageManagementTab];

/** Sub-tab indices inside the Accessibility settings page (mirrors the tab
 *  order in AccessibilitySettings.svelte). */
export const AccessibilityTab = {
    Editing: 0 as const,
    Scroll: 1 as const,
    Sidebar: 2 as const,
    Hotkeys: 3 as const,
    Others: 4 as const,
} as const;

export type AccessibilityTabValue = (typeof AccessibilityTab)[keyof typeof AccessibilityTab];

/**
 * Open the settings panel and navigate to a specific page (and optional
 * System sub-tab). Use this from anywhere in the app that needs to deep-link
 * into settings.
 */
export function openSettings(
    route: SettingsRouteValue,
    storageTab?: StorageManagementTabValue,
    accessibilityTab?: AccessibilityTabValue,
) {
    if (route === SettingsRoute.Migration) {
        SettingsMenuIndex.set(SettingsRoute.System);
        SystemSubmenuIndex.set(StorageManagementTab.Backups);
    } else {
        SettingsMenuIndex.set(route);
    }
    if (storageTab !== undefined) {
        SystemSubmenuIndex.set(storageTab);
    }
    if (accessibilityTab !== undefined) {
        AccessibilitySubmenuIndex.set(accessibilityTab);
    }
    if (route === SettingsRoute.AdminAndStats) {
        AdminStatsSubmenuIndex.set(0);
    }
    settingsOpen.set(true);
}

/** Open the Add-ons settings page at a specific sub-tab. */
export function openAddonSettings(tab: AddonSettingsTabValue = AddonSettingsTab.Plugin) {
    AddonSubmenuIndex.set(tab);
    openSettings(SettingsRoute.Addons);
}

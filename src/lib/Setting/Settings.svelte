<script lang="ts">
    import { AccessibilityIcon, ActivityIcon, PackageIcon, CogIcon, ContactIcon, FlaskConicalIcon, ImageIcon, KeyboardIcon, LanguagesIcon, MonitorIcon, MonitorSmartphoneIcon, SailboatIcon, ScrollTextIcon, SearchIcon, CircleXIcon, FileBoxIcon, ArchiveIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import DisplaySettings from "./Pages/DisplaySettings.svelte";
    import ModelPresetSettings from "./Pages/Model/ModelPresetSettings.svelte";
    import PromptPresetSettings from "./Pages/PromptPresetSettings.svelte";
    import OtherBotSettings from "./Pages/OtherBotSettings.svelte";
    import FilesSettings from "./Pages/FilesSettings.svelte";
    import AdvancedSettings from "./Pages/AdvancedSettings.svelte";
    import StorageManagementSettings from "./Pages/StorageManagementSettings.svelte";
    import AdminStatsSettings from "./Pages/AdminStatsSettings.svelte";
    import { additionalSettingsMenu, AdminStatsSubmenuIndex, SettingsMenuIndex, settingsOpen, SystemSubmenuIndex } from "src/ts/stores.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import LanguageSettings from "./Pages/LanguageSettings.svelte";
    import AccessibilitySettings from "./Pages/AccessibilitySettings.svelte";
    import HotkeySettings from "./Pages/HotkeySettings.svelte";
    import PersonaSettings from "./Pages/PersonaSettings.svelte";
    import InlayImageGallery from "./Pages/InlayImageGallery.svelte";
    import RemoteAccessSettings from "./Pages/RemoteAccessSettings.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import DevPanel from "src/lib/_dev/DevPanel.svelte";
    import AddonSettings from "./Pages/AddonSettings.svelte";
    import IconButtonGroup from "../UI/components/IconButtonGroup.svelte";
    import SortableList from "../UI/components/SortableList.svelte";
    import SettingsSearch from "./SettingsSearch.svelte";
    import { normalizeSettingsMenuOrder, settingsMenuKey, SETTINGS_MENU_SEARCH } from "src/ts/settingsMenuOrder";
    import { SettingsRoute } from "src/ts/routing";
    import { mdViewport } from "src/ts/gui/breakpoints";

    // Dev panel is opt-in via localStorage['risu-dev-panel']='1' in devtools.
    // Read once on mount — flag changes require reload. Gates both the menu
    // button below and the route render branch (SettingsMenuIndex === 99).
    const devPanelEnabled = typeof localStorage !== 'undefined'
        && localStorage.getItem('risu-dev-panel') === '1';
    let searchOpen = $state(false);
    let suppressMenuClick = $state(false);

    const settingsMenuItems = $derived([
        { key: SETTINGS_MENU_SEARCH, index: null, icon: SearchIcon, label: language.searchSettingsButton },
        { key: settingsMenuKey(SettingsRoute.ModelPreset), index: SettingsRoute.ModelPreset, icon: FileBoxIcon, label: language.modelPresetMenu },
        { key: settingsMenuKey(SettingsRoute.PromptPreset), index: SettingsRoute.PromptPreset, icon: ScrollTextIcon, label: language.promptPresetMenu },
        { key: settingsMenuKey(SettingsRoute.Persona), index: SettingsRoute.Persona, icon: ContactIcon, label: language.persona },
        { key: settingsMenuKey(SettingsRoute.OtherBots), index: SettingsRoute.OtherBots, icon: SailboatIcon, label: language.otherBots },
        { key: settingsMenuKey(SettingsRoute.Language), index: SettingsRoute.Language, icon: LanguagesIcon, label: language.language },
        { key: settingsMenuKey(SettingsRoute.Addons), index: SettingsRoute.Addons, icon: PackageIcon, label: language.addons },
        { key: settingsMenuKey(SettingsRoute.Display), index: SettingsRoute.Display, icon: MonitorIcon, label: language.soundAndDisplay },
        { key: settingsMenuKey(SettingsRoute.Accessibility), index: SettingsRoute.Accessibility, icon: AccessibilityIcon, label: language.accessibility },
        { key: settingsMenuKey(SettingsRoute.Hotkeys), index: SettingsRoute.Hotkeys, icon: KeyboardIcon, label: language.hotkey },
        { key: settingsMenuKey(SettingsRoute.Advanced), index: SettingsRoute.Advanced, icon: ActivityIcon, label: language.advancedSettings },
        { key: settingsMenuKey(SettingsRoute.InlayImageGallery), index: SettingsRoute.InlayImageGallery, icon: ImageIcon, label: language.inlayGallery.inlayImageGallery },
        { key: settingsMenuKey(SettingsRoute.RemoteAccess), index: SettingsRoute.RemoteAccess, icon: MonitorSmartphoneIcon, label: language.connectionManagement },
        { key: settingsMenuKey(SettingsRoute.System), index: SettingsRoute.System, icon: ArchiveIcon, label: language.storageManagement },
        { key: settingsMenuKey(SettingsRoute.AdminAndStats), index: SettingsRoute.AdminAndStats, icon: CogIcon, label: language.adminAndStats },
    ]);
    const settingsMenuItemsByKey = $derived(new Map(settingsMenuItems.map((item) => [item.key, item])));
    const settingsMenuOrder = $derived(normalizeSettingsMenuOrder(DBState.db.settingsMenuOrder));
    const visibleSettingsMenuItems = $derived(settingsMenuOrder
        .map((key) => settingsMenuItemsByKey.get(key))
        .filter((item) => item !== undefined));

    function selectMenu(index: number) {
        $SettingsMenuIndex = index;
        if (index === SettingsRoute.System) $SystemSubmenuIndex = 0;
        if (index === SettingsRoute.AdminAndStats) $AdminStatsSubmenuIndex = 0;
    }
    function reorderSettingsMenu(orderedKeys: string[]) {
        DBState.db.settingsMenuOrder = normalizeSettingsMenuOrder(orderedKeys);
    }
    function endMenuDrag() {
        setTimeout(() => {
            suppressMenuClick = false;
        }, 0);
    }
    if(mdViewport.matches() && $SettingsMenuIndex === -1){
        $SettingsMenuIndex = 16
    }

</script>
<div class="setting-bg h-full w-full flex justify-center rs-setting-cont">
    <div class="h-full max-w-4xl w-full flex relative rs-setting-cont-2">
        {#if $mdViewport || $SettingsMenuIndex === -1}
            <div class="flex h-full flex-col bg-darkbg p-4 pt-8 gap-2 overflow-y-auto relative rs-setting-cont-3 shrink-0"
                class:w-full={!$mdViewport}
            >
                <IconButtonGroup
                    size="lg"
                    direction="vertical"
                    className="w-full gap-2 [&>button]:w-full [&>button]:rounded-md [&>button]:justify-start [&>button]:gap-[var(--icon-label-gap)] [&>div]:w-full"
                >
                <SortableList
                    className="w-full flex flex-col gap-2 [&>button]:w-full [&>button]:rounded-md [&>button]:justify-start [&>button]:gap-[var(--icon-label-gap)]"
                    onReorder={reorderSettingsMenu}
                    onDragStart={() => { suppressMenuClick = true }}
                    onDragEnd={endMenuDrag}
                >
                    {#each visibleSettingsMenuItems as item (item.key)}
                        <button
                            data-sortable-key={item.key}
                            class="flex items-center risu-interactive-foreground"
                            class:text-maintext={$SettingsMenuIndex === item.index}
                            class:text-subtext={$SettingsMenuIndex !== item.index}
                            onclick={() => {
                                if (suppressMenuClick) return;
                                if (item.index === null) searchOpen = true;
                                else selectMenu(item.index);
                            }}
                        >
                            <item.icon />
                            <span>{item.label}</span>
                        </button>
                    {/each}
                </SortableList>
                {#if devPanelEnabled}
                    <button class="flex items-center risu-interactive-foreground"
                        class:text-maintext={$SettingsMenuIndex === 99}
                        class:text-subtext={$SettingsMenuIndex !== 99}
                        onclick={() => {
                        $SettingsMenuIndex = 99
                    }}>
                        <FlaskConicalIcon />
                        <span>Dev Panel</span>
                    </button>
                {/if}
                {#if additionalSettingsMenu.length > 0}
                    <div class="border-t border-selected mt-2 pt-2">
                        <span class="text-subtext text-xs ml-1">{language.plugin}</span>
                    </div>
                {/if}
                {#each additionalSettingsMenu as menu}
                    <button class="flex items-center risu-interactive-foreground text-subtext"
                        onclick={() => {
                            menu.callback()
                    }}>
                        <PluginDefinedIcon ico={menu} />
                        <span>{menu.name}</span>
                    </button>
                {/each}
                </IconButtonGroup>
                {#if !$mdViewport}
                    <button class="absolute top-2 right-2 risu-interactive-accent text-maintext" onclick={() => {
                        settingsOpen.set(false)
                    }}> <CircleXIcon size={DBState.db.settingsCloseButtonSize} /> </button>
                {/if}
            </div>
        {/if}
        {#if $mdViewport || $SettingsMenuIndex !== -1}
            {#key $SettingsMenuIndex}
                <div class="grow py-6 px-4 flex flex-col text-maintext overflow-y-auto relative rs-setting-cont-4 risu-list-action-scroll-root risu-surface-light min-w-0">
                    <div class="w-full max-w-2xl mx-auto flex flex-col">
                        {#if $SettingsMenuIndex === 2}
                            <OtherBotSettings />
                        {:else if $SettingsMenuIndex === 3}
                            <DisplaySettings />
                        {:else if $SettingsMenuIndex === 4}
                            <AddonSettings />
                        {:else if $SettingsMenuIndex === 5}
                            <FilesSettings />
                        {:else if $SettingsMenuIndex === 6}
                            <AdvancedSettings />
                        {:else if $SettingsMenuIndex === 10}
                            <LanguageSettings/>
                        {:else if $SettingsMenuIndex === 11}
                            <AccessibilitySettings/>
                        {:else if $SettingsMenuIndex === 25}
                            <HotkeySettings/>
                        {:else if $SettingsMenuIndex === 12}
                            <PersonaSettings/>
                        {:else if $SettingsMenuIndex === 16}
                            <ModelPresetSettings/>
                        {:else if $SettingsMenuIndex === 17}
                            <PromptPresetSettings/>
                        {:else if $SettingsMenuIndex === 23}
                            <InlayImageGallery/>
                        {:else if $SettingsMenuIndex === 21}
                            <RemoteAccessSettings/>
                        {:else if $SettingsMenuIndex === 22}
                            <StorageManagementSettings/>
                        {:else if $SettingsMenuIndex === 24}
                            <AdminStatsSettings/>
                        {:else if $SettingsMenuIndex === 99 && devPanelEnabled}
                            <DevPanel/>
                        {/if}
                    </div>
            </div>
            {/key}
            <button class="absolute top-2 right-2 risu-interactive-accent text-maintext" onclick={() => {
                if($mdViewport){
                    settingsOpen.set(false)
                }
                else{
                    $SettingsMenuIndex = -1
                }
            }}>
                <CircleXIcon size={DBState.db.settingsCloseButtonSize} />
            </button>
        {/if}
    </div>
</div>
<SettingsSearch bind:open={searchOpen} />
<style>
    .setting-bg{
        background: linear-gradient(to right, var(--risu-theme-darkbg) 50%, var(--risu-theme-lightbg) 50%);

    }
</style>

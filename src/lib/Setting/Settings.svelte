<script lang="ts">
    import { AccessibilityIcon, ActivityIcon, PackageIcon, CogIcon, ContactIcon, FlaskConicalIcon, ImageIcon, LanguagesIcon, MonitorIcon, MonitorSmartphoneIcon, Sailboat, ScrollTextIcon, SearchIcon, CircleXIcon, FileBoxIcon, ArchiveIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import DisplaySettings from "./Pages/DisplaySettings.svelte";
    import ModelPresetSettings from "./Pages/Model/ModelPresetSettings.svelte";
    import PromptPresetSettings from "./Pages/PromptPresetSettings.svelte";
    import OtherBotSettings from "./Pages/OtherBotSettings.svelte";
    import FilesSettings from "./Pages/FilesSettings.svelte";
    import AdvancedSettings from "./Pages/AdvancedSettings.svelte";
    import StorageManagementSettings from "./Pages/StorageManagementSettings.svelte";
    import AdminStatsSettings from "./Pages/AdminStatsSettings.svelte";
    import { additionalSettingsMenu, AdminStatsSubmenuIndex, MobileGUI, SettingsMenuIndex, settingsOpen, SystemSubmenuIndex } from "src/ts/stores.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import LanguageSettings from "./Pages/LanguageSettings.svelte";
    import AccessibilitySettings from "./Pages/AccessibilitySettings.svelte";
    import PersonaSettings from "./Pages/PersonaSettings.svelte";
    import PromptSettings from "./Pages/PromptSettings.svelte";
    import { isLite } from "src/ts/lite";
    import InlayImageGallery from "./Pages/InlayImageGallery.svelte";
    import RemoteAccessSettings from "./Pages/RemoteAccessSettings.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import DevPanel from "src/lib/_dev/DevPanel.svelte";
    import AddonSettings from "./Pages/AddonSettings.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
    import SettingsSearch from "./SettingsSearch.svelte";

    // Dev panel is opt-in via localStorage['risu-dev-panel']='1' in devtools.
    // Read once on mount — flag changes require reload. Gates both the menu
    // button below and the route render branch (SettingsMenuIndex === 99).
    const devPanelEnabled = typeof localStorage !== 'undefined'
        && localStorage.getItem('risu-dev-panel') === '1';
    let searchOpen = $state(false);

    const primaryMenuItems = $derived([
        { index: 16, icon: FileBoxIcon, label: language.modelPresetMenu },
        { index: 17, icon: ScrollTextIcon, label: language.promptPresetMenu },
        { index: 12, icon: ContactIcon, label: language.persona },
        { index: 2, icon: Sailboat, label: language.otherBots },
        { index: 10, icon: LanguagesIcon, label: language.language },
    ]);
    const secondaryMenuItems = $derived([
        { index: 4, icon: PackageIcon, label: language.addons },
        { index: 3, icon: MonitorIcon, label: language.soundAndDisplay },
        { index: 11, icon: AccessibilityIcon, label: language.accessibility },
        { index: 6, icon: ActivityIcon, label: language.advancedSettings },
        { index: 23, icon: ImageIcon, label: language.playground.inlayImageGallery },
        { index: 21, icon: MonitorSmartphoneIcon, label: language.connectionManagement },
        { index: 22, icon: ArchiveIcon, label: language.storageManagement },
        { index: 24, icon: CogIcon, label: language.adminAndStats },
    ]);

    function selectMenu(index: number) {
        $SettingsMenuIndex = index;
        if (index === 22) $SystemSubmenuIndex = 0;
        if (index === 24) $AdminStatsSubmenuIndex = 0;
    }
    if(window.innerWidth >= 900 && $SettingsMenuIndex === -1 && !$MobileGUI){
        $SettingsMenuIndex = 16
    }
    if($SettingsMenuIndex === 1 || $SettingsMenuIndex === 15){
        $SettingsMenuIndex = 16
    }
    else if($SettingsMenuIndex === 7){
        $SettingsMenuIndex = 3
    }
    else if($SettingsMenuIndex === 14){
        $SettingsMenuIndex = 4
    }
    else if($SettingsMenuIndex === 0){
        $SettingsMenuIndex = 22
        $SystemSubmenuIndex = 1
    }

</script>
<div class="h-full w-full flex justify-center rs-setting-cont" class:bg-bgcolor={$MobileGUI} class:setting-bg={!$MobileGUI}>
    <div class="h-full max-w-4xl w-full flex relative rs-setting-cont-2">
        {#if (window.innerWidth >= 700 && !$MobileGUI) || $SettingsMenuIndex === -1}
            <div class="flex h-full flex-col p-4 pt-8 gap-2 overflow-y-auto relative rs-setting-cont-3 shrink-0"
                class:w-full={window.innerWidth < 700 || $MobileGUI}
                class:bg-darkbg={!$MobileGUI} class:bg-bgcolor={$MobileGUI}
            >
                <button
                    class="flex items-center gap-2 border border-darkborderc hover:border-borderc rounded-md px-2 py-1.5 text-textcolor2 transition-colors"
                    onclick={() => { searchOpen = true }}
                >
                    <SearchIcon size={16} class="shrink-0" />
                    <span class="text-sm">{language.searchSettingsPlaceholder}</span>
                </button>
                <IconButtonGroup
                    size="lg"
                    direction="vertical"
                    className="w-full gap-2 [&>button]:w-full [&>button]:rounded-md [&>button]:justify-start [&>button]:gap-[var(--icon-label-gap)] [&>div]:w-full"
                >
                {#each ($isLite ? primaryMenuItems.filter((item) => item.index === 10) : primaryMenuItems) as item (item.index)}
                    <button
                        class="flex items-center risu-interactive-foreground"
                        class:text-textcolor={$SettingsMenuIndex === item.index}
                        class:text-textcolor2={$SettingsMenuIndex !== item.index}
                        onclick={() => selectMenu(item.index)}
                    >
                        <item.icon />
                        <span>{item.label}</span>
                    </button>
                {/each}
                {#if !$isLite}
                    {#each secondaryMenuItems as item (item.index)}
                        <button
                            class="flex items-center risu-interactive-foreground"
                            class:text-textcolor={$SettingsMenuIndex === item.index}
                            class:text-textcolor2={$SettingsMenuIndex !== item.index}
                            onclick={() => selectMenu(item.index)}
                        >
                            <item.icon />
                            <span>{item.label}</span>
                        </button>
                    {/each}
                    {#if devPanelEnabled}
                        <button class="flex items-center risu-interactive-foreground"
                            class:text-textcolor={$SettingsMenuIndex === 99}
                            class:text-textcolor2={$SettingsMenuIndex !== 99}
                            onclick={() => {
                            $SettingsMenuIndex = 99
                        }}>
                            <FlaskConicalIcon />
                            <span>Dev Panel</span>
                        </button>
                    {/if}
                    {#if additionalSettingsMenu.length > 0}
                        <div class="border-t border-selected mt-2 pt-2">
                            <span class="text-textcolor2 text-xs ml-1">{language.plugin}</span>
                        </div>
                    {/if}
                    {#each additionalSettingsMenu as menu}
                        <button class="flex items-center risu-interactive-foreground text-textcolor2"
                            onclick={() => {
                                menu.callback()
                        }}>
                            <PluginDefinedIcon ico={menu} />
                            <span>{menu.name}</span>
                        </button>
                    {/each}

                {/if}
                </IconButtonGroup>
                {#if window.innerWidth < 700 && !$MobileGUI}
                    <button class="absolute top-2 right-2 risu-interactive-accent text-textcolor" onclick={() => {
                        settingsOpen.set(false)
                    }}> <CircleXIcon size={DBState.db.settingsCloseButtonSize} /> </button>
                {/if}
            </div>
        {/if}
        {#if (window.innerWidth >= 700 && !$MobileGUI) || $SettingsMenuIndex !== -1}
            {#key $SettingsMenuIndex}
                <div class="grow py-6 px-4 bg-bgcolor flex flex-col text-textcolor overflow-y-auto relative rs-setting-cont-4 min-w-0">
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
                        {:else if $SettingsMenuIndex === 12}
                            <PersonaSettings/>
                        {:else if $SettingsMenuIndex === 13}
                            <PromptSettings onGoBack={() => {
                                $SettingsMenuIndex = 17
                            }}/>
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
            {#if !$MobileGUI}
                <button class="absolute top-2 right-2 risu-interactive-accent text-textcolor" onclick={() => {
                    if(window.innerWidth >= 700){
                        settingsOpen.set(false)
                    }
                    else{
                        $SettingsMenuIndex = -1
                    }
                }}>
                    <CircleXIcon size={DBState.db.settingsCloseButtonSize} />
                </button>
            {/if}
        {/if}
    </div>
</div>
<SettingsSearch bind:open={searchOpen} />
<style>
    .setting-bg{
        background: linear-gradient(to right, var(--risu-theme-darkbg) 50%, var(--risu-theme-bgcolor) 50%);

    }
</style>

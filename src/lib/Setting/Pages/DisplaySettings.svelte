<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import PresetHeader from "src/lib/UI/GUI/PresetHeader.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { DBState, openThemePresetList } from "src/ts/stores.svelte";
    import NotificationSoundSettings from "./NotificationSoundSettings.svelte";
    import {
        displayOtherHomeItems,
        displayOtherChatItems,
        displayOtherQuoteItems,
        displayOtherAdvancedItems,
        displaySizeSettingsItems,
        displayThemeGeneralSettingsItems,
        displayThemePaletteSettingsItems,
    } from "src/ts/setting/displaySettingsData.svelte";

    let submenu = $state(0);
</script>

<SettingPage title={language.soundAndDisplay}>
<PresetHeader
    label={language.currentThemePreset}
    activeName={DBState.db.themePresets?.[DBState.db.themePresetsId]?.name ?? 'Default'}
    onManage={() => openThemePresetList.set(true)}
/>
<SettingTabs
    tabs={[
        { label: language.theme, value: 0 },
        { label: language.sizeAndSpeed, value: 1 },
        { label: language.others, value: 2 },
        { label: language.soundAndNotification, value: 3 },
    ]}
    bind:selected={submenu}
/>

{#if submenu === 0}
    <SettingLayout variant="section" title={language.normal} first>
        <SettingRenderer items={displayThemeGeneralSettingsItems} layout="row" />
    </SettingLayout>
    <SettingLayout variant="section" title={language.colorScheme}>
        <SettingRenderer items={displayThemePaletteSettingsItems} layout="row" />
    </SettingLayout>
{:else if submenu === 1}
    <SettingRenderer items={displaySizeSettingsItems} layout="row" />
{:else if submenu === 2}
    <SettingLayout variant="section" title={language.sectionHomeList} first><SettingRenderer items={displayOtherHomeItems} layout="row" /></SettingLayout>
    <SettingLayout variant="section" title={language.sectionChatView}><SettingRenderer items={displayOtherChatItems} layout="row" /></SettingLayout>
    <SettingLayout variant="section" title={language.sectionQuotes}><SettingRenderer items={displayOtherQuoteItems} layout="row" /></SettingLayout>
    <SettingLayout variant="section" title={language.sectionAdvanced}><SettingRenderer items={displayOtherAdvancedItems} layout="row" /></SettingLayout>
{:else if submenu === 3}
    <NotificationSoundSettings embedded />
{/if}
</SettingPage>

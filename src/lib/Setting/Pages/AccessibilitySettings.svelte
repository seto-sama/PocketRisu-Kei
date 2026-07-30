<script lang="ts">
    import SettingRenderer from "../SettingRenderer.svelte";
    import {
        accessibilityEditingItems,
        accessibilityScrollItems,
        accessibilityChatPanelItems,
        accessibilityInputItems,
        accessibilityMenuBarItems,
        accessibilityOtherItems,
    } from "src/ts/setting/accessibilitySettingsData";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import { language } from "src/lang";
    import { AccessibilitySubmenuIndex } from "src/ts/stores.svelte";
    import HotkeySettings from "./HotkeySettings.svelte";
</script>

<SettingPage title={language.accessibility}>
<SettingTabs
    tabs={[
        { label: language.accTabEditing, value: 0 },
        { label: language.accTabScroll, value: 1 },
        { label: language.accTabSidebar, value: 2 },
        { label: language.hotkey, value: 3 },
        { label: language.others, value: 4 },
    ]}
    bind:selected={$AccessibilitySubmenuIndex}
/>

{#if $AccessibilitySubmenuIndex === 0}
    <SettingRenderer items={accessibilityEditingItems} layout="row" />
{:else if $AccessibilitySubmenuIndex === 1}
    <SettingRenderer items={accessibilityScrollItems} layout="row" />
{:else if $AccessibilitySubmenuIndex === 2}
    <h3 class="text-base font-bold mt-4 mb-1">{language.accSectionChatPanel}</h3>
    <SettingRenderer items={accessibilityChatPanelItems} layout="row" />
    <h3 class="text-base font-bold mt-8 mb-1">{language.accSectionInput}</h3>
    <SettingRenderer items={accessibilityInputItems} layout="row" />
    <h3 class="text-base font-bold mt-8 mb-1">{language.accSectionMenuBar}</h3>
    <SettingRenderer items={accessibilityMenuBarItems} layout="row" />
{:else if $AccessibilitySubmenuIndex === 3}
    <HotkeySettings />
{:else if $AccessibilitySubmenuIndex === 4}
    <SettingRenderer items={accessibilityOtherItems} layout="row" />
{/if}
</SettingPage>

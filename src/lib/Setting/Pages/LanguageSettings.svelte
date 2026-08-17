<script lang="ts">
    import {
        languageAndDisplaySettingsItems,
        translationBehaviorItems,
        translatorConfigurationItems,
    } from "src/ts/setting/languageSettingsData.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import { language } from "src/lang";
    import TranslationCachePanel from "./Language/TranslationCachePanel.svelte";
    import { LanguageSubmenuIndex } from "src/ts/stores.svelte";
</script>

<SettingPage title={language.language}>
<SettingTabs
    tabs={[
        { label: language.generalSettings, value: 0 },
        { label: language.translationCache, value: 1 },
    ]}
    bind:selected={$LanguageSubmenuIndex}
/>

{#if $LanguageSubmenuIndex === 0}
    <div class="flex flex-col w-full">
        <SettingLayout variant="section" title={language.languageSettingsSection} first><SettingRenderer items={languageAndDisplaySettingsItems} layout="row" /></SettingLayout>
        <SettingLayout variant="section" title={language.translatorConfigurationSection}><SettingRenderer items={translatorConfigurationItems} layout="row" /></SettingLayout>
        <SettingLayout variant="section" title={language.translatorSettingsSection}><SettingRenderer items={translationBehaviorItems} layout="row" /></SettingLayout>
    </div>
{:else if $LanguageSubmenuIndex === 1}
    <TranslationCachePanel />
{/if}
</SettingPage>

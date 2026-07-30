<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import PluginSettings from "./PluginSettings.svelte";
    import ModuleSettings from "./Module/ModuleSettings.svelte";
    import { AddonSubmenuIndex } from "src/ts/stores.svelte";
</script>

<SettingPage title={language.addons}>
    <SettingTabs
        tabs={[
            { label: language.plugin, value: 0 },
            { label: language.modules, value: 1 },
            { label: 'MCP', value: 2 },
        ]}
        bind:selected={$AddonSubmenuIndex}
    />

    {#if $AddonSubmenuIndex === 0}
        <PluginSettings embedded />
    {:else if $AddonSubmenuIndex === 1}
        <ModuleSettings embedded view="modules" />
    {:else if $AddonSubmenuIndex === 2}
        <ModuleSettings embedded view="mcp" />
    {/if}
</SettingPage>

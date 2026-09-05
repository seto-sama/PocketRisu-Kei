<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "../../UI/components/SettingPage.svelte";
    import SettingTabs from "../../UI/components/SettingTabs.svelte";
    import PluginSettings from "./PluginSettings.svelte";
    import ModuleSettings from "./Module/ModuleSettings.svelte";
    import { AddonSubmenuIndex } from "src/ts/stores.svelte";

    let { embedded = false }: { embedded?: boolean } = $props();
</script>

<SettingPage title={embedded ? undefined : language.addons}>
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

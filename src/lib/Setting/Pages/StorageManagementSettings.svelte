<script lang="ts">
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte'
    import SettingTabs from 'src/lib/UI/GUI/SettingTabs.svelte'
    import SystemDashboard from './SystemDashboard.svelte'
    import SystemBackup from './SystemBackup.svelte'
    import PluginStorageViewer from './PluginStorageViewer.svelte'
    import { SystemSubmenuIndex } from 'src/ts/stores.svelte'
    import { language } from 'src/lang'
</script>

<SettingPage title={language.storageManagement}>
    <SettingTabs tabs={[
        { label: language.systemDashboard, value: 0 },
        { label: language.systemBackups, value: 1 },
        { label: language.pluginStorageTab, value: 2 },
    ]} bind:selected={$SystemSubmenuIndex} />

    {#if $SystemSubmenuIndex === 0}
        <SystemDashboard />
    {:else if $SystemSubmenuIndex === 1}
        <SystemBackup />
    {:else if $SystemSubmenuIndex === 2}
        <PluginStorageViewer />
    {/if}
</SettingPage>

<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import ColorInput from 'src/lib/UI/GUI/ColorInput.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte';

    interface Props {
        field: 'textScreenColor' | 'textScreenBorder';
        labelKey: 'textBackgrounds' | 'textScreenBorder';
        defaultColor: string;
        helpKey?: 'textScreenColor' | 'textScreenBorder';
    }

    let { field, labelKey, defaultColor, helpKey }: Props = $props();
    let currentValue = $derived(DBState.db[field]);
    const helpText = $derived(helpKey ? (language.help as any)[helpKey] : undefined);
</script>

<SettingLayout variant="row" title={language[labelKey]} description={helpText}>
    {#snippet control()}
    <div class="flex items-center gap-2">
        {#if currentValue}
            <ColorInput bind:value={DBState.db[field]} />
        {/if}
        <ShSwitch
            checked={!!currentValue}
            onCheckedChange={(v) => {
                DBState.db[field] = v ? defaultColor : null;
            }}
        />
    </div>
    {/snippet}
</SettingLayout>

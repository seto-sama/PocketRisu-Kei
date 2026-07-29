<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
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
            <input
                type="color"
                class="h-8 w-10 rounded border border-darkborderc bg-transparent cursor-pointer"
                value={currentValue}
                oninput={(e) => {
                    DBState.db[field] = e.currentTarget.value;
                }}
            />
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

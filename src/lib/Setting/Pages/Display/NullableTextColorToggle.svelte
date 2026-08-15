<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import ColorInput from 'src/lib/UI/GUI/ColorInput.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte';

    interface Props {
        field: 'textScreenColor' | 'textBorderColor';
        toggleField?: 'textBorder';
        labelKey: 'textBackgrounds' | 'textBorder';
        defaultColor: string;
        helpKey?: 'textScreenColor' | 'textBorder';
        alwaysEnabled?: boolean;
    }

    let { field, toggleField, labelKey, defaultColor, helpKey, alwaysEnabled = false }: Props = $props();
    let currentValue = $derived(DBState.db[field]);
    let enabled = $derived(alwaysEnabled || (toggleField ? !!DBState.db[toggleField] : !!currentValue));
    const helpText = $derived(helpKey ? (language.help as any)[helpKey] : undefined);

    $effect(() => {
        if (alwaysEnabled && !DBState.db[field]) DBState.db[field] = defaultColor;
    });
</script>

<SettingLayout variant="row" title={language[labelKey]} description={helpText}>
    {#snippet control()}
    <div class="flex items-center gap-2">
        {#if enabled}
            <ColorInput bind:value={DBState.db[field]} />
        {/if}
        {#if !alwaysEnabled}
            <ShSwitch
                checked={enabled}
                onCheckedChange={(v) => {
                    if (toggleField) {
                        DBState.db[toggleField] = v;
                        if (v) DBState.db[field] ??= defaultColor;
                    } else {
                        DBState.db[field] = v ? defaultColor : null;
                    }
                }}
            />
        {/if}
    </div>
    {/snippet}
</SettingLayout>

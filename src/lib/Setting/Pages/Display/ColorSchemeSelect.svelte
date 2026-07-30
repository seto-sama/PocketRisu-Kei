<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import { changeColorScheme, colorSchemeList, nonLegacyColorSchemes, colorSchemeLabels } from 'src/ts/gui/colorscheme';
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte';
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte';

    let showLegacy = $state(false);

    const onSchemeInputChange = (e: Event) => {
        changeColorScheme((e.target as HTMLInputElement).value);
    };

    // Non-legacy schemes are always listed. Legacy schemes appear only when the
    // toggle is on, or when one is already selected (so the dropdown keeps
    // reflecting the current value even with the toggle off).
    const visibleSchemes = $derived(
        colorSchemeList.filter(
            (scheme) =>
                nonLegacyColorSchemes.has(scheme) ||
                showLegacy ||
                scheme === DBState.db.colorSchemeName,
        ),
    );

    // Pretty display label: "default" is localized, classics use the static
    // label map (others fall back to the key), with a "(legacy)" suffix on
    // legacy schemes.
    const optionLabel = (scheme: string) => {
        const base =
            scheme === 'default'
                ? language.colorSchemeDefault
                : (colorSchemeLabels[scheme] ?? scheme);
        return nonLegacyColorSchemes.has(scheme) ? base : `${base} (legacy)`;
    };
</script>

<SettingLayout variant="row" title={language.colorScheme} description={language.help.colorScheme}>
    {#snippet control()}
        <SelectInput className="w-48" size="sm" value={DBState.db.colorSchemeName} onchange={onSchemeInputChange}>
            {#each visibleSchemes as scheme}
                <OptionInput value={scheme}>{optionLabel(scheme)}</OptionInput>
            {/each}
            <OptionInput value="custom">Custom</OptionInput>
        </SelectInput>
    {/snippet}
</SettingLayout>

{#if DBState.db.colorSchemeName !== 'custom'}
    <SettingLayout variant="row" title={language.showLegacyColorSchemes}>
        {#snippet control()}
            <ShSwitch checked={showLegacy} onCheckedChange={(c) => (showLegacy = c)} />
        {/snippet}
    </SettingLayout>
{/if}

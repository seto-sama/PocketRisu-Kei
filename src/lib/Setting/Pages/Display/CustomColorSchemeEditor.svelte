<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import {
        changeColorSchemeType,
        exportColorScheme,
        importColorScheme,
        updateColorScheme,
    } from 'src/ts/gui/colorscheme';
    import ColorInput from 'src/lib/UI/GUI/ColorInput.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte';
    import { language } from 'src/lang';
    import { DownloadIcon, HardDriveUploadIcon } from '@lucide/svelte';

    const colors = [
        ['bgcolor', 'Background'],
        ['darkbg', 'Dark Background'],
        ['borderc', 'UI Color 1 (Focus / Strong Border)'],
        ['selected', 'UI Color 2 (Selected / Hover)'],
        ['darkBorderc', 'UI Color 3 (Dark Border)'],
        ['darkbutton', 'UI Color 4 (Button)'],
        ['textcolor', 'UI Text Color 1'],
        ['textcolor2', 'UI Text Color 2'],
        ['draculared', 'Color 1 (Danger / Error)'],
        ['highlight', 'Color 2 (Highlight / Attention)'],
        ['warning', 'Color 3 (Warning)'],
        ['success', 'Color 4 (Success)'],
        ['primary', 'Color 5 (Primary / Active)'],
        ['accent', 'Color 6 (Accent / Info)'],
        ['scoped', 'Color 7 (Scoped / Special)'],
    ] as const;
</script>

{#if DBState.db.colorSchemeName === 'custom'}
    <SettingLayout variant="row" title="Dark Mode">
        {#snippet control()}
            <ShSwitch
                checked={DBState.db.colorScheme.type === 'dark'}
                onCheckedChange={(checked) => changeColorSchemeType(checked ? 'dark' : 'light')}
            />
        {/snippet}
    </SettingLayout>

    {#each colors as color}
        <SettingLayout variant="row" title={color[1]}>
            {#snippet control()}
                <div class="shrink-0">
                    <ColorInput bind:value={DBState.db.colorScheme[color[0]]} oninput={updateColorScheme} />
                </div>
            {/snippet}
        </SettingLayout>
    {/each}

    <SettingLayout
        variant="row"
        title={language.colorScheme}
        description={language.help.colorSchemeTransferDesc}
        actions={[
            { label: language.import, onclick: importColorScheme, icon: HardDriveUploadIcon },
            { label: language.export, onclick: exportColorScheme, icon: DownloadIcon },
        ]}
    />
{/if}

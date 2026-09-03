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
    import { DownloadIcon, UploadIcon } from '@lucide/svelte';

    const colors = [
        ['lightbg', 'Light Background'],
        ['darkbg', 'Dark Background'],
        ['maintext', 'Main Text Color'],
        ['subtext', 'Sub Text Color'],
        ['lightborderc', 'UI Color 1 (Light Border)'],
        ['darkborderc', 'UI Color 2 (Dark Border)'],
        ['selected', 'UI Color 3 (Selected / Hover)'],
        ['button', 'UI Color 4 (Button)'],
        ['white', 'UI Color 5 (White)'],
        ['black', 'UI Color 6 (Black)'],
        ['danger', 'Color 1 (Danger / Error)'],
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
            { label: language.import, onclick: importColorScheme, icon: UploadIcon },
            { label: language.export, onclick: exportColorScheme, icon: DownloadIcon },
        ]}
    />
{/if}

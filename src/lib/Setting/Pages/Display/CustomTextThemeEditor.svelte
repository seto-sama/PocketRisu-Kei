<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import { updateTextThemeAndCSS } from 'src/ts/gui/colorscheme';
    import ColorInput from '../../../UI/components/ColorInput.svelte';

    const colors = [
        ['FontColorStandard', 'Normal Text', false],
        ['FontColorItalic', 'Italic Text', false],
        ['FontColorBold', 'Bold Text', false],
        ['FontColorItalicBold', 'Italic Bold Text', false],
        ['FontColorQuote1', 'Single Quote Text', true],
        ['FontColorQuote2', 'Double Quote Text', true],
    ] as const;
</script>

{#if DBState.db.textTheme === 'custom'}
    {#each colors as color}
        <div class="flex items-center justify-between gap-3 py-2">
            <span class="text-sm text-maintext min-w-0 truncate">{color[1]}</span>
            <div class="shrink-0">
                <ColorInput
                    nullable={color[2]}
                    bind:value={DBState.db.customTextTheme[color[0]]}
                    oninput={updateTextThemeAndCSS}
                />
            </div>
        </div>
    {/each}
{/if}

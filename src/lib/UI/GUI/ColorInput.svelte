<script lang="ts">
    import ColorPicker from 'svelte-awesome-color-picker';
    import { ColorSchemeTypeStore } from 'src/ts/gui/colorscheme';

    interface Props {
        value?: string | null;
        nullable?: boolean;
        oninput?: () => void;
    }

    let { value = $bindable(), nullable = false, oninput }: Props = $props();
    let pickerValue = $derived(value === undefined ? '#000000' : value);
</script>

<div class="cl" class:dark={$ColorSchemeTypeStore === 'dark'}>
    <ColorPicker
        label="" hex={pickerValue}
        nullable={nullable}
        onInput={({ hex }) => {
            value = hex;
            oninput?.();
        }}
    />
</div>

<style>
    .cl{
        --input-size: 2rem;
        --cp-bg-color: var(--risu-theme-bgcolor);
        --cp-border-color: var(--risu-theme-darkborderc);
        --cp-text-color: var(--risu-theme-textcolor);
        --focus-color: var(--risu-theme-primary);
        --swatch-border-color: var(--color-black);
        --cp-input-color: var(--risu-theme-darkbg);
        --cp-button-hover-color: var(--risu-theme-selected);
    }

    .cl.dark {
        --swatch-border-color: var(--color-white);
    }

    .cl :global(label) {
        height: 2rem;
        margin: 0;
        border-radius: 0.25rem;
    }

    .cl :global(label .container),
    .cl :global(label .alpha),
    .cl :global(label .color) {
        width: 2rem;
        height: 2rem;
        border-radius: 0.25rem;
        box-sizing: border-box;
    }

    .cl :global(label .alpha) {
        clip-path: none;
    }

    .cl :global(label .color) {
        border: 2px solid var(--swatch-border-color);
    }

    /*
     * Anchor the picker popup to the swatch's right edge so it always opens
     * leftward (into the panel). The library's responsive positioning measures
     * window width, not the narrow centered settings panel, so on a wide/fullscreen
     * window it wrongly opens the popup rightward and it gets clipped past the
     * panel edge. Our color swatches sit on the right side of the panel, so
     * left-opening keeps the popup inside. NOTE: assumes a right-aligned swatch —
     * see SettingColor.svelte (left-aligned) if it ever becomes active.
     */
    .cl :global(.wrapper[role="dialog"]) {
        left: auto !important;
        right: 0;
    }
</style>

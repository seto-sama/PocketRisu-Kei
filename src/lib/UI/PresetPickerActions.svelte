<script lang="ts">
    import { UploadIcon, PlusIcon } from "@lucide/svelte";
    import type { Snippet } from "svelte";
    import IconButton from "./components/IconButton.svelte";
    import ActionBar from "./components/ActionBar.svelte";
    import IconButtonGroup from "./components/IconButtonGroup.svelte";

    interface Props {
        onCreate?: () => void;
        onImport?: () => void;
        children?: Snippet;
    }

    let { onCreate, onImport, children }: Props = $props();
</script>

<ActionBar mode="inline">
    <IconButtonGroup>
        {#if onCreate}
            <IconButton onclick={onCreate}>
                <PlusIcon/>
            </IconButton>
        {/if}
        {#if onImport}
            <IconButton onclick={onImport} data-file-picker>
                <UploadIcon />
            </IconButton>
        {/if}
        {@render children?.()}
    </IconButtonGroup>
</ActionBar>

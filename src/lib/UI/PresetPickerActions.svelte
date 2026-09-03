<script lang="ts">
    import { UploadIcon, PlusIcon } from "@lucide/svelte";
    import IconButton from "./GUI/IconButton.svelte";
    import IconButtonGroup from "./GUI/IconButtonGroup.svelte";

    interface Props {
        onCreate?: () => void;
        onImport?: () => void;
    }

    let { onCreate, onImport }: Props = $props();
</script>

<IconButtonGroup className="pt-2 mt-2 border-t border-darkborderc">
    {#if onCreate}
        <IconButton onclick={onCreate}>
            <PlusIcon/>
        </IconButton>
    {/if}
    {#if onImport}
        <IconButton onclick={onImport}>
            <UploadIcon />
        </IconButton>
    {/if}
</IconButtonGroup>

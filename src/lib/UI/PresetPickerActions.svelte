<script lang="ts">
    import { UploadIcon, PlusIcon } from "@lucide/svelte";
    import IconButton from "./components/IconButton.svelte";
    import ListActionBar from "./components/ListActionBar.svelte";

    interface Props {
        onCreate?: () => void;
        onImport?: () => void;
    }

    let { onCreate, onImport }: Props = $props();
</script>

<ListActionBar mode="inline">
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
</ListActionBar>

<script lang="ts">
    import { HardDriveUploadIcon, PencilIcon, PlusIcon } from "@lucide/svelte";
    import IconButton from "./GUI/IconButton.svelte";
    import IconButtonGroup from "./GUI/IconButtonGroup.svelte";

    interface Props {
        onCreate?: () => void;
        onImport?: () => void;
        onRename?: () => void;
    }

    let { onCreate, onImport, onRename }: Props = $props();
</script>

<IconButtonGroup className="pt-2 mt-2 border-t border-darkborderc">
    {#if onCreate}
        <IconButton onclick={onCreate}>
            <PlusIcon/>
        </IconButton>
    {/if}
    {#if onImport}
        <IconButton onclick={onImport}>
            <HardDriveUploadIcon />
        </IconButton>
    {/if}
    {#if onRename}
        <IconButton onclick={onRename}>
            <PencilIcon />
        </IconButton>
    {/if}
</IconButtonGroup>

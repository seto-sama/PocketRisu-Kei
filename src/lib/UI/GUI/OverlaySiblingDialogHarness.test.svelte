<script lang="ts">
    import OverlayPortal from './OverlayPortal.svelte'
    import ShDialog from './ShDialog.svelte'

    let dialogOpen = $state(false)
</script>

<ShDialog bind:open={dialogOpen} closeOnOutsideClick={false} closable={false}>
    <div><input aria-label="Folder name" /></div>
    {#snippet footer()}<button>Confirm</button>{/snippet}
</ShDialog>

<OverlayPortal>
    <div class="risu-modal-backdrop risu-layer-overlay">
        <button data-testid="open-sibling-dialog" onclick={() => dialogOpen = true}>Rename</button>
    </div>
</OverlayPortal>

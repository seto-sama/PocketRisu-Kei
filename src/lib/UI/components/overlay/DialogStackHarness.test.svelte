<script lang="ts">
    import Dialog from '../Dialog.svelte'

    let lowerOpen = $state(true)
    let upperOpen = $state(true)
</script>

<Dialog bind:open={lowerOpen} closable={false} onConfirm={() => { lowerOpen = false }}>
    {#snippet title()}Lower dialog{/snippet}
    <button>Lower action</button>
</Dialog>

<Dialog bind:open={upperOpen} closable={false} role="alertdialog"
    onConfirm={() => { upperOpen = false }}>
    {#snippet title()}Upper dialog{/snippet}
    <button>Upper action</button>
</Dialog>

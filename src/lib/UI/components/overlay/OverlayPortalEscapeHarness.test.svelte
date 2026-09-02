<script lang="ts">
    import OverlayPortal from './OverlayPortal.svelte'

    const { onEscape }: { onEscape: () => void } = $props()
</script>

<OverlayPortal {onEscape}>
    <input data-testid="overlay-input" onkeydown={(event) => event.stopPropagation()} />
</OverlayPortal>

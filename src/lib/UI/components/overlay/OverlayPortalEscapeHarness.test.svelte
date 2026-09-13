<script lang="ts">
    import OverlayPortal from './OverlayPortal.svelte'
    import OverlayBackdrop from './OverlayBackdrop.svelte'

    const {
        onEscape,
        onOuterClose,
        onInnerClose,
    }: {
        onEscape?: () => void
        onOuterClose?: () => void
        onInnerClose?: () => void
    } = $props()
    let outerOpen = $state(true)
    let innerOpen = $state(true)
</script>

{#if onEscape}
    <OverlayPortal {onEscape}>
        <input data-testid="overlay-input" onkeydown={(event) => event.stopPropagation()} />
    </OverlayPortal>
{:else}
    {#if outerOpen}
        <OverlayPortal>
            <OverlayBackdrop
                bind:open={outerOpen}
                onOpenChange={(open) => { if (!open) onOuterClose?.() }}
            >
                <div data-testid="outer-overlay">
                    {#if innerOpen}
                        <OverlayPortal>
                            <OverlayBackdrop
                                bind:open={innerOpen}
                                onOpenChange={(open) => { if (!open) onInnerClose?.() }}
                            >
                                <div data-testid="inner-overlay"></div>
                            </OverlayBackdrop>
                        </OverlayPortal>
                    {/if}
                </div>
            </OverlayBackdrop>
        </OverlayPortal>
    {/if}
{/if}

<script lang="ts">
    import { getContext, type Snippet } from 'svelte'
    import {
        overlayLayerContext,
        overlayLayerMinimum,
        type OverlayLayerGetter,
    } from 'src/ts/gui/overlayStack'

    interface Props {
        interactive?: boolean
        children: Snippet
    }

    const { interactive = false, children }: Props = $props()
    const overlayLayer = getContext<OverlayLayerGetter | undefined>(overlayLayerContext)
    const zIndex = $derived(overlayLayer?.() ?? overlayLayerMinimum)
</script>

<!-- A zero-size viewport-anchored stacking context keeps fixed/absolute
     children positioned correctly without intercepting outside clicks. -->
<div
    data-risu-overlay-layer={zIndex}
    data-risu-dialog-interactive={interactive || undefined}
    class:pointer-events-auto={interactive}
    style="position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: {zIndex}; --risu-overlay-z: {zIndex};"
>
    {@render children()}
</div>

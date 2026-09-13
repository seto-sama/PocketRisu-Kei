<script lang="ts">
    import type { Snippet } from 'svelte'
    import { provideOverlayLayer } from 'src/ts/gui/overlayLayer.svelte'
    import { listenForOverlayEscape } from 'src/ts/gui/overlayDismiss'
    import OverlayLayerRoot from './OverlayLayerRoot.svelte'
    import Portal from './Portal.svelte'

    interface Props {
        target?: HTMLElement
        active?: boolean
        onEscape?: () => void
        children: Snippet
    }

    const { target, active = true, onEscape, children }: Props = $props()
    const overlayLayer = provideOverlayLayer(() => active)

    $effect(() => {
        if (!active || !onEscape) return
        return listenForOverlayEscape(onEscape, () => overlayLayer.allocatedZIndex)
    })
</script>

<Portal {target}>
    <OverlayLayerRoot interactive>
        {@render children()}
    </OverlayLayerRoot>
</Portal>

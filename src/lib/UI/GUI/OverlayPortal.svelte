<script lang="ts">
    import type { Snippet } from 'svelte'
    import { provideOverlayLayer } from 'src/ts/gui/overlayLayer.svelte'
    import { isTopOverlayLayer } from 'src/ts/gui/overlayStack'
    import OverlayLayerRoot from './OverlayLayerRoot.svelte'
    import Portal from './Portal.svelte'

    interface Props {
        target?: HTMLElement
        onEscape?: () => void
        children: Snippet
    }

    const { target, onEscape, children }: Props = $props()
    const overlayLayer = provideOverlayLayer()

    function handleKeydown(event: KeyboardEvent) {
        if (
            event.key !== 'Escape' || event.defaultPrevented || !onEscape ||
            !isTopOverlayLayer(overlayLayer.allocatedZIndex)
        ) return

        if (event.target instanceof Element && event.target.closest('[data-inline-name-editor]')) return

        event.preventDefault()
        onEscape()
    }

    $effect(() => {
        if (!onEscape) return
        window.addEventListener('keydown', handleKeydown, true)
        return () => window.removeEventListener('keydown', handleKeydown, true)
    })
</script>

<Portal {target}>
    <OverlayLayerRoot interactive>
        {@render children()}
    </OverlayLayerRoot>
</Portal>

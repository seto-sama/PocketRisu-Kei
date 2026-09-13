<script lang="ts">
    import { getContext, type Snippet } from 'svelte'
    import type { HTMLAttributes } from 'svelte/elements'
    import { overlayLayerContext, isTopOverlayLayer, type OverlayLayerGetter } from 'src/ts/gui/overlayStack'
    import { listenForOverlayEscape } from 'src/ts/gui/overlayDismiss'

    interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'onclick' | 'children'> {
        open?: boolean
        onOpenChange?: (open: boolean) => void
        dismissible?: boolean
        onRequestClose?: () => void
        children: Snippet
    }

    let {
        open = $bindable(true),
        onOpenChange,
        dismissible = true,
        onRequestClose,
        children,
        ...attributes
    }: Props = $props()
    const layer = getContext<OverlayLayerGetter>(overlayLayerContext)

    function close() {
        if (onRequestClose) onRequestClose()
        else {
            open = false
            onOpenChange?.(false)
        }
    }

    $effect(() => {
        if (!open || attributes.inert || attributes.hidden || attributes['aria-hidden'] === true || attributes['aria-hidden'] === 'true') return
        // Blocking windows still consume Escape so it cannot close a parent or
        // fall through to mobile page navigation.
        return listenForOverlayEscape(() => { if (dismissible) close() }, layer)
    })

    function handleClick(event: MouseEvent) {
        if (!dismissible || event.target !== event.currentTarget || !isTopOverlayLayer(layer())) return
        close()
    }
</script>

<!-- Background clicks and Escape always share the same dismissal callback. -->
{#if open}
    <div {...attributes} role="presentation" onclick={handleClick}>
        {@render children()}
    </div>
{/if}

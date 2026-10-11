<script lang="ts">
    import { getContext, type Snippet } from 'svelte'
    import type { HTMLAttributes } from 'svelte/elements'
    import { overlayLayerContext, isTopOverlayLayer, type OverlayLayerGetter } from 'src/ts/gui/overlayStack'
    import { listenForOverlayEscape } from 'src/ts/gui/overlayDismiss'

    interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'onclick' | 'children'> {
        open?: boolean
        onOpenChange?: (open: boolean) => void
        dismissible?: boolean
        keepMounted?: boolean
        onRequestClose?: () => void
        children: Snippet
    }

    let {
        open = $bindable(true),
        onOpenChange,
        dismissible = true,
        keepMounted = false,
        onRequestClose,
        children,
        ...attributes
    }: Props = $props()
    const layer = getContext<OverlayLayerGetter>(overlayLayerContext)
    let hasOpened = $state(false)

    $effect.pre(() => {
        if (open) hasOpened = true
    })

    function close() {
        if (onRequestClose) onRequestClose()
        else {
            open = false
            onOpenChange?.(false)
        }
    }

    $effect(() => {
        if (!open || attributes.inert || attributes.hidden || attributes['aria-hidden'] === true || attributes['aria-hidden'] === 'true') return
        // Blocking overlays consume Escape to protect parent overlays and page navigation.
        return listenForOverlayEscape(() => { if (dismissible) close() }, layer)
    })

    function handleClick(event: MouseEvent) {
        if (!dismissible || event.target !== event.currentTarget || !isTopOverlayLayer(layer())) return
        close()
    }
</script>

{#if open || (keepMounted && hasOpened)}
    <div
        {...attributes}
        hidden={!open || attributes.hidden}
        inert={!open || attributes.inert}
        aria-hidden={!open ? true : attributes['aria-hidden']}
        role="presentation"
        onclick={handleClick}
    >
        {@render children()}
    </div>
{/if}

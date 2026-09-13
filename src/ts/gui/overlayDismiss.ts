import { isTopOverlayLayer, type OverlayLayerGetter } from './overlayStack'

/** One Escape dismisses only the top overlay, including when focus is outside it. */
export function listenForOverlayEscape(close: () => void, layer: OverlayLayerGetter): () => void {
    const handleKeydown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !isTopOverlayLayer(layer())) return
        if (event.target instanceof Element && event.target.closest('[data-inline-name-editor]')) return
        event.preventDefault()
        event.stopPropagation()
        close()
    }
    window.addEventListener('keydown', handleKeydown, true)
    return () => window.removeEventListener('keydown', handleKeydown, true)
}

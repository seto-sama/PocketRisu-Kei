import {
    acquireOverlayLayer,
    getOverlayLayer,
    hasOverlayLayer,
    overlayLayerMinimum,
    setOverlayLayer,
} from './overlayStack'

/** Connects the overlay allocator to a Svelte component and its descendants. */
export function provideOverlayLayer(isActive: () => boolean = () => true) {
    const parentLayer = hasOverlayLayer() ? getOverlayLayer() : undefined
    let allocatedZIndex = $state<number>()

    setOverlayLayer(() => allocatedZIndex ?? parentLayer?.())

    $effect(() => {
        if (!isActive()) return

        const lease = acquireOverlayLayer({ parent: parentLayer?.() })
        allocatedZIndex = lease.zIndex

        return () => {
            allocatedZIndex = undefined
            lease.release()
        }
    })

    return {
        get zIndex() {
            return allocatedZIndex ?? overlayLayerMinimum
        },
        get allocatedZIndex() {
            return allocatedZIndex
        },
    }
}

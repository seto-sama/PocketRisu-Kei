import { getContext, setContext } from 'svelte'
import {
    acquireOverlayLayer,
    overlayLayerContext,
    overlayLayerMinimum,
    type OverlayLayerGetter,
} from './overlayStack'

/** Connects the overlay allocator to a Svelte component and its descendants. */
export function provideOverlayLayer(isActive: () => boolean = () => true) {
    const parentLayer = getContext<OverlayLayerGetter | undefined>(overlayLayerContext)
    let allocatedZIndex = $state<number>()

    setContext<OverlayLayerGetter>(
        overlayLayerContext,
        () => allocatedZIndex ?? parentLayer?.(),
    )

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

export type OverlayLayerGetter = () => number | undefined

export const overlayLayerContext = Symbol('risu-overlay-layer')
// Leaves ample room above static application chrome and common local z-indexes.
export const overlayLayerMinimum = 1000

const activeLayers = new Map<symbol, number>()

export function isTopOverlayLayer(zIndex: number | undefined) {
    if (zIndex === undefined) return false
    return zIndex === Math.max(0, ...activeLayers.values())
}

export type OverlayLayerLease = {
    zIndex: number
    release: () => void
}

/**
 * Allocates a layer above every currently open portal overlay and its parent.
 * Releasing leases lets the stack collapse instead of growing indefinitely.
 */
export function acquireOverlayLayer(options: {
    minimum?: number
    parent?: number
} = {}): OverlayLayerLease {
    const id = Symbol('risu-overlay')
    const highestActive = Math.max(0, ...activeLayers.values())
    const zIndex = Math.max(
        options.minimum ?? overlayLayerMinimum,
        highestActive + 1,
        (options.parent ?? 0) + 1,
    )
    activeLayers.set(id, zIndex)

    return {
        zIndex,
        release() {
            activeLayers.delete(id)
        },
    }
}

/** Svelte action for legacy overlay roots that do not use a portal component. */
export function overlayLayer(node: HTMLElement) {
    const lease = acquireOverlayLayer()
    node.style.setProperty('--risu-overlay-z', lease.zIndex.toString())
    node.dataset.risuOverlayLayer = lease.zIndex.toString()
    return {
        destroy: lease.release,
    }
}

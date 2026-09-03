export type VisualViewportBounds = {
    top: number
    left: number
    right: number
    bottom: number
    width: number
    height: number
    layoutWidth: number
    layoutHeight: number
}

/** Current visible browser area, including mobile browser chrome and zoom. */
export function getVisualViewportBounds(): VisualViewportBounds {
    const viewport = window.visualViewport
    const top = viewport?.offsetTop ?? 0
    const left = viewport?.offsetLeft ?? 0
    const width = viewport?.width ?? window.innerWidth
    const height = viewport?.height ?? window.innerHeight

    return {
        top,
        left,
        right: left + width,
        bottom: top + height,
        width,
        height,
        layoutWidth: window.innerWidth,
        layoutHeight: window.innerHeight,
    }
}

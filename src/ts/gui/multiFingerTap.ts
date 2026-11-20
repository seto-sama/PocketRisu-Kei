const TAP_MAX_MS = 500
const TAP_SLOP_PX = 12

interface TapGesture {
    startedAt: number
    maxTouches: number
    moved: boolean
    cancelled: boolean
    origins: Map<number, { x: number, y: number }>
    target: EventTarget | null
}

/**
 * Deciding on release (not when the Nth finger lands) keeps a four-finger tap from
 * first matching three, and the movement check keeps pinch and scroll out.
 * `onTap` returns whether it handled the tap, which cancels the synthetic click so the
 * focused field and the mobile keyboard stay put.
 */
export function installMultiFingerTap(
    onTap: (fingers: number, target: EventTarget | null) => boolean,
): () => void {
    let gesture: TapGesture | null = null

    const start = (event: TouchEvent) => {
        gesture ??= {
            startedAt: performance.now(), maxTouches: 0, moved: false, cancelled: false,
            origins: new Map(), target: event.target,
        }
        for (const touch of Array.from(event.changedTouches)) {
            gesture.origins.set(touch.identifier, { x: touch.clientX, y: touch.clientY })
        }
        gesture.maxTouches = Math.max(gesture.maxTouches, event.touches.length)
    }

    const move = (event: TouchEvent) => {
        if (!gesture || gesture.moved) return
        for (const touch of Array.from(event.changedTouches)) {
            const origin = gesture.origins.get(touch.identifier)
            if (origin && Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > TAP_SLOP_PX) {
                gesture.moved = true
            }
        }
    }

    const end = (event: TouchEvent) => {
        if (!gesture) return
        // A cancel may drop only some contacts, so it voids the tap even if the rest lift normally.
        if (event.type === 'touchcancel') gesture.cancelled = true
        if (event.touches.length > 0) return
        const tap = gesture
        gesture = null
        if (tap.cancelled || tap.moved || tap.maxTouches < 2) return
        if (performance.now() - tap.startedAt > TAP_MAX_MS) return
        if (onTap(tap.maxTouches, tap.target)) event.preventDefault()
    }

    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: true })
    document.addEventListener('touchend', end)
    document.addEventListener('touchcancel', end)
    return () => {
        document.removeEventListener('touchstart', start)
        document.removeEventListener('touchmove', move)
        document.removeEventListener('touchend', end)
        document.removeEventListener('touchcancel', end)
    }
}

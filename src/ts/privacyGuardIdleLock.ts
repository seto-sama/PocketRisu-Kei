const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const
const CHECK_INTERVAL_MS = 15_000

interface IdleLockOptions {
    getMinutes: () => number | undefined
    /** Work the user is waiting on, such as a reply being generated, counts as activity. */
    isBusy: () => boolean
    lock: () => void
}

/** Runs until it locks once; it then stops watching, since locking ends the page session. */
export function startIdleLock({ getMinutes, isBusy, lock }: IdleLockOptions) {
    let lastActivity = Date.now()
    const markActive = () => { lastActivity = Date.now() }
    const check = () => {
        if (isBusy()) return markActive()
        const minutes = getMinutes()
        if (!(minutes > 0) || Date.now() - lastActivity < minutes * 60_000) return
        stop()
        lock()
    }
    // Background tabs throttle timers, so also check the moment the page is shown again.
    const onVisibility = () => { if (document.visibilityState === 'visible') check() }
    const timer = setInterval(check, CHECK_INTERVAL_MS)
    function stop() {
        clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisibility)
        for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, markActive, { capture: true })
    }

    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, markActive, { capture: true, passive: true })
    document.addEventListener('visibilitychange', onVisibility)
}

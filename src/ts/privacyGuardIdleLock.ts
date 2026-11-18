const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const
const CHECK_INTERVAL_MS = 15_000

interface IdleLockOptions {
    /** Idle minutes before locking; anything not positive disables the lock. */
    getMinutes: () => number | undefined
    /** Work the user is waiting on, such as a reply being generated, counts as activity. */
    isBusy: () => boolean
    lock: () => void
}

export function startIdleLock({ getMinutes, isBusy, lock }: IdleLockOptions) {
    let lastActivity = Date.now()
    let locked = false
    const markActive = () => { lastActivity = Date.now() }
    const check = () => {
        if (locked) return
        if (isBusy()) return markActive()
        const minutes = getMinutes()
        if (!minutes || minutes <= 0) return
        if (Date.now() - lastActivity < minutes * 60_000) return
        locked = true
        lock()
    }
    // Background tabs throttle timers, so also check the moment the page is shown again.
    const onVisibility = () => { if (document.visibilityState === 'visible') check() }

    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, markActive, { capture: true, passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    const timer = setInterval(check, CHECK_INTERVAL_MS)
    return () => {
        clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisibility)
        for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, markActive, { capture: true })
    }
}

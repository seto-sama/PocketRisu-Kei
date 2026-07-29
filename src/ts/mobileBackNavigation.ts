import { isIOS, isMobile } from './platform'

const MOBILE_BACK_GUARD_STATE = '__pocketRisuMobileBackGuard'

type HistoryLike = Pick<History, 'back' | 'pushState' | 'state'>
type NavigationEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

const USER_ACTIVATION_EVENTS = ['pointerdown', 'touchstart', 'keydown'] as const

function isGuardState(state: unknown): boolean {
    return typeof state === 'object'
        && state !== null
        && (state as Record<string, unknown>)[MOBILE_BACK_GUARD_STATE] === true
}

function withGuardState(state: unknown): Record<string, unknown> {
    const existingState = typeof state === 'object' && state !== null
        ? state as Record<string, unknown>
        : {}

    return {
        ...existingState,
        [MOBILE_BACK_GUARD_STATE]: true,
    }
}

export function createMobileBackNavigationGuard(
    browserHistory: HistoryLike,
    eventTarget: NavigationEventTarget,
    hasUserActivation: () => boolean = () => navigator.userActivation?.hasBeenActive ?? false,
) {
    let enabled = false
    let cleanupPending = false
    let beforeUnloadListening = false

    const arm = () => {
        if (isGuardState(browserHistory.state)) return
        browserHistory.pushState(withGuardState(browserHistory.state), '', window.location.href)
    }

    const handlePopState = () => {
        if (cleanupPending) {
            cleanupPending = false
            if (enabled) arm()
            return
        }

        if (enabled) arm()
    }

    const handleUserActivation = () => {
        if (enabled) arm()
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        if (!enabled) return
        event.preventDefault()
        event.returnValue = ''
    }

    const setBeforeUnloadListening = (shouldListen: boolean) => {
        if (beforeUnloadListening === shouldListen) return
        beforeUnloadListening = shouldListen

        if (shouldListen) {
            eventTarget.addEventListener('beforeunload', handleBeforeUnload)
        } else {
            eventTarget.removeEventListener('beforeunload', handleBeforeUnload)
        }
    }

    eventTarget.addEventListener('popstate', handlePopState)
    for (const eventName of USER_ACTIVATION_EVENTS) {
        eventTarget.addEventListener(eventName, handleUserActivation, { capture: true, passive: true })
    }

    return {
        setEnabled(nextEnabled: boolean, activatedByUser = false) {
            if (enabled === nextEnabled) {
                if (enabled && (activatedByUser || hasUserActivation())) arm()
                return
            }

            enabled = nextEnabled
            setBeforeUnloadListening(enabled)
            if (enabled) {
                // Mobile browsers may mark history entries created before any
                // user interaction as skippable and close the tab from their
                // Back UI. Create the guard only after a real activation.
                if (activatedByUser || hasUserActivation()) arm()
            } else if (isGuardState(browserHistory.state)) {
                // The guard always has a same-page entry immediately behind it,
                // so walking back once removes it without leaving the app.
                cleanupPending = true
                browserHistory.back()
            }
        },
        destroy() {
            enabled = false
            setBeforeUnloadListening(false)
            eventTarget.removeEventListener('popstate', handlePopState)
            for (const eventName of USER_ACTIVATION_EVENTS) {
                eventTarget.removeEventListener(eventName, handleUserActivation, { capture: true })
            }
        },
    }
}

let mobileBackNavigationGuard: ReturnType<typeof createMobileBackNavigationGuard> | undefined

export function syncMobileBackNavigationGuard(enabled: boolean, activatedByUser = false): void {
    if (!mobileBackNavigationGuard) {
        mobileBackNavigationGuard = createMobileBackNavigationGuard(window.history, window)
    }

    mobileBackNavigationGuard.setEnabled(enabled && (isMobile || isIOS()), activatedByUser)
}

import { isIOS, isMobile } from './platform'
import { requestEscapeAction } from './gui/escapeKey'
import { v4 as uuidv4 } from 'uuid'

const MOBILE_BACK_GUARD_STATE = '__pocketRisuMobileBackGuard'

type HistoryLike = Pick<History, 'back' | 'forward' | 'go' | 'pushState' | 'state'>
type NavigationEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

const USER_ACTIVATION_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown'] as const

async function confirmLeavePage(): Promise<boolean> {
    const [{ alertConfirm }, { language }] = await Promise.all([import('./alert'), import('../lang')])
    return alertConfirm(language.confirmLeavePage)
}

function isGuardState(state: unknown, guardId: string): boolean {
    return typeof state === 'object'
        && state !== null
        && (state as Record<string, unknown>)[MOBILE_BACK_GUARD_STATE] === guardId
}

function withGuardState(state: unknown, guardId: string): Record<string, unknown> {
    const existingState = typeof state === 'object' && state !== null
        ? state as Record<string, unknown>
        : {}

    return {
        ...existingState,
        [MOBILE_BACK_GUARD_STATE]: guardId,
    }
}

export function createMobileBackNavigationGuard(
    browserHistory: HistoryLike,
    eventTarget: NavigationEventTarget,
    hasUserActivation: () => boolean = () => navigator.userActivation?.hasBeenActive ?? false,
    requestEscape: () => boolean = requestEscapeAction,
    requestLeaveConfirmation: () => Promise<boolean> = confirmLeavePage,
) {
    // history.state survives reloads; only trust a guard created by this instance.
    const guardId = uuidv4()
    let active = false
    let preventNavigation = false
    let historyNavigationPending: 'restore' | 'leave' | 'cleanup' | 'pass-through' | undefined
    let beforeUnloadListening = false
    let confirmationQueued = false
    let confirmationPending = false
    let leaveApproved = false

    const arm = () => {
        if (isGuardState(browserHistory.state, guardId)) return
        browserHistory.pushState(withGuardState(browserHistory.state, guardId), '', window.location.href)
    }

    const leave = () => {
        historyNavigationPending = 'leave'
        // Skip the guard and its same-page base only after explicit confirmation.
        browserHistory.go(-2)
    }

    const confirmLeave = async () => {
        confirmationQueued = false
        confirmationPending = true
        try {
            const approved = await requestLeaveConfirmation()
            if (!active || !approved) return
            leaveApproved = true
            if (!historyNavigationPending) leave()
        } finally {
            confirmationPending = false
        }
    }

    const handlePopState = () => {
        // Programmatic history traversal must not dispatch another Escape.
        if (historyNavigationPending) {
            const completedNavigation = historyNavigationPending
            historyNavigationPending = undefined
            if (completedNavigation === 'leave') {
                leaveApproved = false
                return
            }
            if (active) arm()
            if (active && leaveApproved) {
                // A confirmation may resolve while its Escape is restoring the
                // guard. Wait for restoration before skipping both entries.
                leave()
            } else if (active && confirmationQueued) {
                void confirmLeave()
            }
            return
        }

        if (!active) return
        const escapeConsumed = requestEscape()
        if (escapeConsumed || preventNavigation || confirmationPending) {
            // Reuse the guard entry we just left. Chromium can mark entries
            // pushed after Back as skippable until the next user activation.
            historyNavigationPending = 'restore'
            if (!escapeConsumed && !confirmationPending && preventNavigation) confirmationQueued = true
            browserHistory.forward()
            return
        }

        // The first Back only consumed our same-page guard. Continue to the
        // user's actual destination when no Escape action handled it.
        historyNavigationPending = 'pass-through'
        browserHistory.back()
    }

    const handleUserActivation = (event: Event) => {
        if (!event.isTrusted || !active || historyNavigationPending) return
        // Recognize real activation directly, including browsers without the
        // UserActivation API. Touch/pen activates on release; mouse on press.
        if (event.type === 'pointerdown' && (event as PointerEvent).pointerType !== 'mouse') return
        if (event.type === 'pointerup' && (event as PointerEvent).pointerType === 'mouse') return
        if (event.type === 'keydown') {
            const keyEvent = event as KeyboardEvent
            if (keyEvent.key === 'Escape' || keyEvent.ctrlKey || keyEvent.metaKey || keyEvent.altKey) return
        }
        arm()
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        if (!active || !preventNavigation || leaveApproved) return
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
        setEnabled(nextPreventNavigation: boolean, activatedByUser = false, nextActive = true) {
            preventNavigation = nextPreventNavigation
            setBeforeUnloadListening(nextActive && preventNavigation)

            if (active === nextActive) {
                if (active && !historyNavigationPending && (activatedByUser || hasUserActivation())) arm()
                return
            }

            active = nextActive
            if (active) {
                // Mobile browsers may mark history entries created before any
                // user interaction as skippable and close the tab from their
                // Back UI. Create the guard only after a real activation.
                if (activatedByUser || hasUserActivation()) arm()
            } else if (isGuardState(browserHistory.state, guardId)) {
                // The guard always has a same-page entry immediately behind it,
                // so walking back once removes it without leaving the app.
                historyNavigationPending = 'cleanup'
                browserHistory.back()
            }
        },
        destroy() {
            active = false
            preventNavigation = false
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

    const mobile = isMobile || isIOS()
    mobileBackNavigationGuard.setEnabled(enabled, activatedByUser, mobile)
}

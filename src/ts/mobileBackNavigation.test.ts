import { describe, expect, it, vi } from 'vitest'
import { createMobileBackNavigationGuard } from './mobileBackNavigation'

function createHarness(
    initialState: unknown = null,
    requestEscape = vi.fn(() => false),
    hasUserActivation = () => true,
    requestLeaveConfirmation = vi.fn(async () => false),
) {
    let state = initialState
    const listeners = new Map<string, Set<(event?: Event) => void>>()

    const browserHistory = {
        get state() {
            return state
        },
        back: vi.fn(),
        forward: vi.fn(),
        go: vi.fn(),
        pushState: vi.fn((nextState: unknown) => {
            state = nextState
        }),
    }
    const eventTarget = {
        addEventListener: vi.fn((type: string, listener: (event?: Event) => void) => {
            const typeListeners = listeners.get(type) ?? new Set()
            typeListeners.add(listener)
            listeners.set(type, typeListeners)
        }),
        removeEventListener: vi.fn((type: string, listener: (event?: Event) => void) => {
            listeners.get(type)?.delete(listener)
        }),
    }
    const guard = createMobileBackNavigationGuard(
        browserHistory as unknown as Parameters<typeof createMobileBackNavigationGuard>[0],
        eventTarget as unknown as Parameters<typeof createMobileBackNavigationGuard>[1],
        hasUserActivation,
        requestEscape,
        requestLeaveConfirmation,
    )

    return {
        browserHistory,
        eventTarget,
        guard,
        requestEscape,
        requestLeaveConfirmation,
        dispatch(type: string, event: Event = new Event(type)) {
            for (const listener of listeners.get(type) ?? []) listener(event)
        },
        navigateBackTo(nextState: unknown) {
            state = nextState
            for (const listener of listeners.get('popstate') ?? []) listener()
        },
    }
}

describe('mobile back navigation guard', () => {
    it('reuses one guard entry across repeated Back presses without another touch', () => {
        const harness = createHarness({ route: 'chat' }, vi.fn(() => true))

        harness.guard.setEnabled(true)
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)
        expect(harness.browserHistory.state).toMatchObject({ route: 'chat' })
        const guardState = harness.browserHistory.state

        harness.guard.setEnabled(true)
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)

        for (let press = 1; press <= 3; press++) {
            harness.navigateBackTo({ route: 'chat' })
            expect(harness.browserHistory.forward).toHaveBeenCalledTimes(press)
            harness.guard.setEnabled(true)
            harness.dispatch('keydown')
            harness.navigateBackTo(guardState)
            expect(harness.requestEscape).toHaveBeenCalledTimes(press)
            expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)
        }
    })

    it('uses Back as Escape before navigation even when prevention is disabled', () => {
        const requestEscape = vi.fn(() => true)
        const harness = createHarness(null, requestEscape)

        harness.guard.setEnabled(false)
        harness.navigateBackTo(null)

        expect(requestEscape).toHaveBeenCalledTimes(1)
        expect(harness.browserHistory.back).not.toHaveBeenCalled()
        expect(harness.browserHistory.forward).toHaveBeenCalledTimes(1)
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)
    })

    it('continues navigation when Escape is unhandled and prevention is disabled', () => {
        const harness = createHarness()

        harness.guard.setEnabled(false)
        harness.navigateBackTo(null)
        expect(harness.browserHistory.back).toHaveBeenCalledTimes(1)

        harness.navigateBackTo({ route: 'previous' })
        expect(harness.requestEscape).toHaveBeenCalledTimes(1)
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(2)
        expect(harness.browserHistory.state).toMatchObject({ route: 'previous' })
    })

    it('keeps modal Back working across repeated cancelled confirmations without touching again', async () => {
        const requestEscape = vi.fn(() => false)
        const harness = createHarness(null, requestEscape)
        harness.guard.setEnabled(true)
        const guardState = harness.browserHistory.state

        for (let attempt = 1; attempt <= 3; attempt++) {
            requestEscape.mockReturnValue(false)
            harness.navigateBackTo(null)
            harness.navigateBackTo(guardState)
            await Promise.resolve()
            expect(harness.requestLeaveConfirmation).toHaveBeenCalledTimes(attempt)

            requestEscape.mockReturnValue(true)
            harness.navigateBackTo(null)
            harness.navigateBackTo(guardState)
            expect(harness.requestLeaveConfirmation).toHaveBeenCalledTimes(attempt)
            expect(harness.browserHistory.pushState).toHaveBeenCalledOnce()
            expect(harness.browserHistory.back).not.toHaveBeenCalled()
            expect(harness.browserHistory.go).not.toHaveBeenCalled()
        }
    })

    it('leaves only after confirmation and does not show a second native prompt', async () => {
        const confirm = vi.fn(async () => true)
        const harness = createHarness(null, undefined, undefined, confirm)
        harness.guard.setEnabled(true)
        const guardState = harness.browserHistory.state
        harness.navigateBackTo(null)
        harness.navigateBackTo(guardState)
        await Promise.resolve()

        expect(harness.browserHistory.go).toHaveBeenCalledExactlyOnceWith(-2)
        const event = new Event('beforeunload', { cancelable: true })
        harness.dispatch('beforeunload', event)
        expect(event.defaultPrevented).toBe(false)

        // A same-document destination must not trigger a second traversal.
        harness.navigateBackTo({ route: 'previous' })
        expect(harness.browserHistory.go).toHaveBeenCalledOnce()
        expect(harness.browserHistory.pushState).toHaveBeenCalledOnce()
    })

    it.each([false, true])('serializes a confirmation result (%s) with an in-flight Back restoration', async (approved) => {
        let resolveConfirmation!: (value: boolean) => void
        const confirm = vi.fn(() => new Promise<boolean>(resolve => { resolveConfirmation = resolve }))
        const requestEscape = vi.fn(() => false)
        const harness = createHarness(null, requestEscape, undefined, confirm)
        harness.guard.setEnabled(true)
        const guardState = harness.browserHistory.state
        harness.navigateBackTo(null)
        harness.navigateBackTo(guardState)

        // The confirmation itself is an Escape-consuming modal.
        requestEscape.mockReturnValue(true)
        harness.navigateBackTo(null)
        resolveConfirmation(approved)
        await Promise.resolve()
        expect(harness.browserHistory.go).not.toHaveBeenCalled()
        harness.navigateBackTo(guardState)

        expect(confirm).toHaveBeenCalledOnce()
        expect(harness.browserHistory.go).toHaveBeenCalledTimes(approved ? 1 : 0)
        expect(harness.browserHistory.pushState).toHaveBeenCalledOnce()
    })

    it('removes its guard entry when mobile handling is deactivated', () => {
        const harness = createHarness()

        harness.guard.setEnabled(false)
        harness.guard.setEnabled(false, false, false)
        expect(harness.browserHistory.back).toHaveBeenCalledTimes(1)

        harness.navigateBackTo(null)
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)
        expect(harness.requestEscape).not.toHaveBeenCalled()
    })

    it('stops reacting to popstate events after destruction', () => {
        const harness = createHarness()

        harness.guard.setEnabled(true)
        harness.guard.destroy()
        harness.navigateBackTo(null)

        expect(harness.eventTarget.removeEventListener).toHaveBeenCalled()
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)
    })

    it('replaces a persisted guard marker after reload', () => {
        const restoredState = { route: 'chat', __pocketRisuMobileBackGuard: 'previous-document' }
        const harness = createHarness(restoredState, vi.fn(() => true))
        harness.guard.setEnabled(true)

        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)
        expect(harness.browserHistory.state).toMatchObject({ route: 'chat' })
        expect(harness.browserHistory.state).not.toEqual(restoredState)
        harness.navigateBackTo(restoredState)
        expect(harness.requestEscape).toHaveBeenCalledOnce()
        expect(harness.browserHistory.forward).toHaveBeenCalledOnce()
    })

    it('arms on a real touch even without the UserActivation API', () => {
        const harness = createHarness(null, undefined, () => false)
        harness.guard.setEnabled(true)
        harness.dispatch('pointerdown', { type: 'pointerdown', pointerType: 'touch', isTrusted: true } as PointerEvent)
        expect(harness.browserHistory.pushState).not.toHaveBeenCalled()

        harness.dispatch('touchend', { type: 'touchend', isTrusted: true } as Event)
        expect(harness.browserHistory.pushState).toHaveBeenCalledOnce()
    })

    it('cancels a real page unload as a fallback while enabled', () => {
        const harness = createHarness()
        const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent

        harness.guard.setEnabled(true)
        harness.dispatch('beforeunload', event)
        expect(event.defaultPrevented).toBe(true)

        harness.guard.setEnabled(false)
        const disabledEvent = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
        harness.dispatch('beforeunload', disabledEvent)
        expect(disabledEvent.defaultPrevented).toBe(false)
    })
})

import { describe, expect, it, vi } from 'vitest'
import { createMobileBackNavigationGuard } from './mobileBackNavigation'

function createHarness(initialState: unknown = null) {
    let state = initialState
    const listeners = new Map<string, Set<(event?: Event) => void>>()

    const browserHistory = {
        get state() {
            return state
        },
        back: vi.fn(),
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
        () => true,
    )

    return {
        browserHistory,
        eventTarget,
        guard,
        dispatch(type: string, event?: Event) {
            for (const listener of listeners.get(type) ?? []) listener(event)
        },
        navigateBackTo(nextState: unknown) {
            state = nextState
            for (const listener of listeners.get('popstate') ?? []) listener()
        },
    }
}

describe('mobile back navigation guard', () => {
    it('adds one same-page guard entry and restores it after back navigation', () => {
        const harness = createHarness({ route: 'chat' })

        harness.guard.setEnabled(true)
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)
        expect(harness.browserHistory.state).toMatchObject({
            route: 'chat',
            __pocketRisuMobileBackGuard: true,
        })

        harness.guard.setEnabled(true)
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)

        harness.navigateBackTo({ route: 'chat' })
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(2)
        expect(harness.browserHistory.state).toMatchObject({
            route: 'chat',
            __pocketRisuMobileBackGuard: true,
        })
    })

    it('removes its guard entry when disabled without immediately rearming', () => {
        const harness = createHarness()

        harness.guard.setEnabled(true)
        harness.guard.setEnabled(false)
        expect(harness.browserHistory.back).toHaveBeenCalledTimes(1)

        harness.navigateBackTo(null)
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)
    })

    it('stops reacting to popstate events after destruction', () => {
        const harness = createHarness()

        harness.guard.setEnabled(true)
        harness.guard.destroy()
        harness.navigateBackTo(null)

        expect(harness.eventTarget.removeEventListener).toHaveBeenCalled()
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)
    })

    it('waits for a user interaction before creating a boot-time guard', () => {
        let activated = false
        const harness = createHarness()
        const deferredGuard = createMobileBackNavigationGuard(
            harness.browserHistory as unknown as Parameters<typeof createMobileBackNavigationGuard>[0],
            harness.eventTarget as unknown as Parameters<typeof createMobileBackNavigationGuard>[1],
            () => activated,
        )

        deferredGuard.setEnabled(true)
        expect(harness.browserHistory.pushState).not.toHaveBeenCalled()

        activated = true
        harness.dispatch('pointerdown')
        expect(harness.browserHistory.pushState).toHaveBeenCalledTimes(1)
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

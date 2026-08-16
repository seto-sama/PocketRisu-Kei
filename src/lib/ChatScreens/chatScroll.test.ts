// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createChatScrollController,
    didNewResponseComplete,
    getCompletedResponseAction,
    getScrollDistanceFromBottom,
    isChatNearBottom,
    isChatScrolledToBottom,
    type ChatResponseSnapshot,
} from './chatScroll'

afterEach(() => {
    document.body.replaceChildren()
    vi.unstubAllGlobals()
})

function responseSnapshot(
    overrides: Partial<ChatResponseSnapshot> = {},
): ChatResponseSnapshot {
    return {
        roomKey: 'character:room',
        messageKey: 'response-1',
        messageCount: 2,
        isCharacterResponse: true,
        hasContent: false,
        isResponding: true,
        ...overrides,
    }
}

function setScrollMetrics(
    container: HTMLElement,
    metrics: { scrollHeight: number; clientHeight: number },
) {
    Object.defineProperties(container, {
        scrollHeight: {
            configurable: true,
            get: () => metrics.scrollHeight,
        },
        clientHeight: {
            configurable: true,
            get: () => metrics.clientHeight,
        },
    })
}

function installLayoutObservers() {
    let resizeCallback: ResizeObserverCallback | null = null
    let mutationCallback: MutationCallback | null = null
    let mutationObserveOptions: MutationObserverInit | null = null
    const observedElements = new Set<Element>()

    class TestResizeObserver {
        constructor(callback: ResizeObserverCallback) {
            resizeCallback = callback
        }
        observe(element: Element) {
            observedElements.add(element)
        }
        unobserve(element: Element) {
            observedElements.delete(element)
        }
        disconnect() {
            observedElements.clear()
        }
    }

    class TestMutationObserver {
        constructor(callback: MutationCallback) {
            mutationCallback = callback
        }
        observe(_target: Node, options?: MutationObserverInit) {
            mutationObserveOptions = options ?? null
        }
        disconnect() {}
    }

    let nextFrame = 1
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.stubGlobal('MutationObserver', TestMutationObserver)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = nextFrame++
        frames.set(id, callback)
        return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        frames.delete(id)
    })

    return {
        notifyResize() {
            resizeCallback?.([], {} as ResizeObserver)
        },
        notifyMutation() {
            mutationCallback?.([], {} as MutationObserver)
        },
        flushFrames() {
            const pending = [...frames.values()]
            frames.clear()
            pending.forEach(callback => callback(0))
        },
        observedElements,
        get mutationObserveOptions() {
            return mutationObserveOptions
        },
    }
}

function createController(container: HTMLElement) {
    document.body.appendChild(container)
    return createChatScrollController(container)
}

describe('new response completion timing', () => {
    it('waits for a streaming response to finish', () => {
        const previous = responseSnapshot({ hasContent: false })
        const firstToken = responseSnapshot({ hasContent: true })
        const completed = responseSnapshot({ hasContent: true, isResponding: false })

        expect(didNewResponseComplete(previous, firstToken)).toBe(false)
        expect(didNewResponseComplete(firstToken, completed)).toBe(true)
    })

    it('recognizes an already-populated non-streaming response when it settles', () => {
        const previous = responseSnapshot({
            messageKey: 'user-1',
            messageCount: 1,
            isCharacterResponse: false,
            hasContent: true,
            isResponding: false,
        })

        expect(didNewResponseComplete(previous, responseSnapshot({
            hasContent: true,
            isResponding: false,
        }))).toBe(true)
    })

    it('does not trigger twice or across room and continuation changes', () => {
        const completed = responseSnapshot({ hasContent: true, isResponding: false })
        expect(didNewResponseComplete(completed, completed)).toBe(false)

        const populated = responseSnapshot({ hasContent: true })
        expect(didNewResponseComplete(populated, {
            ...completed,
            roomKey: 'character:other-room',
        })).toBe(false)
        expect(didNewResponseComplete(populated, {
            ...completed,
            messageKey: 'continuation-generation',
        })).toBe(false)
    })
})

describe('completed response behavior', () => {
    it('selects scroll, notification, or no action from one policy', () => {
        expect(getCompletedResponseAction({
            autoScroll: true,
            buttonEnabled: true,
            nearBottom: false,
        })).toBe('scroll')
        expect(getCompletedResponseAction({
            autoScroll: false,
            buttonEnabled: true,
            nearBottom: false,
        })).toBe('notify')
        expect(getCompletedResponseAction({
            autoScroll: true,
            buttonEnabled: true,
            nearBottom: true,
        })).toBe('none')
    })
})

describe('forward chat scroll metrics', () => {
    it('uses the ordinary positive distance from the bottom', () => {
        expect(getScrollDistanceFromBottom(800, 1000, 200)).toBe(0)
        expect(getScrollDistanceFromBottom(650, 1000, 200)).toBe(150)
        expect(isChatScrolledToBottom(799.5, 1000, 200)).toBe(true)
        expect(isChatScrolledToBottom(790, 1000, 200)).toBe(false)
        expect(isChatNearBottom(701, 1000, 200)).toBe(true)
        expect(isChatNearBottom(699, 1000, 200)).toBe(false)
    })
})

describe('forward chat scroll controller', () => {
    it('keeps the initial bottom latch when layout emits scroll before resize', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const metrics = { scrollHeight: 1000, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        const controller = createController(container)

        observers.flushFrames()
        expect(container.scrollTop).toBe(800)

        metrics.scrollHeight = 1120
        container.dispatchEvent(new Event('scroll'))
        observers.notifyResize()
        observers.flushFrames()
        expect(container.scrollTop).toBe(920)
        controller.destroy()
    })

    it('does not pull a reader back when an upward wheel precedes Firefox scrollTop', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const metrics = { scrollHeight: 1000, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        const controller = createController(container)
        observers.flushFrames()

        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -24 }))
        metrics.scrollHeight = 1100
        observers.notifyResize()
        observers.flushFrames()
        expect(container.scrollTop).toBe(800)

        container.scrollTop = 740
        container.dispatchEvent(new Event('scroll'))
        metrics.scrollHeight = 1200
        observers.notifyResize()
        observers.flushFrames()
        expect(container.scrollTop).toBe(740)
        controller.destroy()
    })

    it('relatches only after the reader reaches the exact bottom', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const metrics = { scrollHeight: 1000, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        const controller = createController(container)
        observers.flushFrames()

        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -24 }))
        container.scrollTop = 600
        container.dispatchEvent(new Event('scroll'))
        container.scrollTop = 800
        container.dispatchEvent(new Event('scroll'))

        metrics.scrollHeight = 1100
        observers.notifyResize()
        observers.flushFrames()
        expect(container.scrollTop).toBe(900)
        controller.destroy()
    })

    it('defers bottom writes during direct touch manipulation', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const metrics = { scrollHeight: 1000, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        const controller = createController(container)
        observers.flushFrames()

        container.dispatchEvent(new Event('touchstart'))
        metrics.scrollHeight = 1100
        container.dispatchEvent(new Event('scroll'))
        observers.notifyResize()
        observers.flushFrames()
        expect(container.scrollTop).toBe(800)

        window.dispatchEvent(new Event('touchend'))
        observers.flushFrames()
        expect(container.scrollTop).toBe(900)
        controller.destroy()
    })

    it('releases the bottom latch when direct manipulation actually moves', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const metrics = { scrollHeight: 1000, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        const controller = createController(container)
        observers.flushFrames()

        container.dispatchEvent(new Event('pointerdown'))
        container.scrollTop = 600
        container.dispatchEvent(new Event('scroll'))
        window.dispatchEvent(new Event('pointerup'))

        metrics.scrollHeight = 1100
        observers.notifyResize()
        observers.flushFrames()
        expect(container.scrollTop).toBe(600)
        controller.destroy()
    })

    it('observes nested message layout without injecting pixel spacers', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const message = document.createElement('div')
        message.className = 'chat-message-container'
        container.appendChild(message)
        const metrics = { scrollHeight: 1000, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        const controller = createController(container)

        expect(observers.mutationObserveOptions).toEqual({
            childList: true,
            subtree: true,
        })
        expect(observers.observedElements.has(message)).toBe(true)
        expect(container.querySelector('[data-streaming-pixel-spacer]')).toBeNull()
        controller.destroy()
    })

    it('preserves an edited message position while away from the bottom', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const message = document.createElement('div')
        message.className = 'chat-message-container'
        container.appendChild(message)
        const metrics = { scrollHeight: 1200, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        let messageLayoutTop = 120
        message.getBoundingClientRect = () => new DOMRect(
            0,
            messageLayoutTop - container.scrollTop,
            300,
            100,
        )
        const controller = createController(container)
        observers.flushFrames()
        container.scrollTop = 100
        container.dispatchEvent(new Event('scroll'))

        const release = controller.preserveElementPosition(message)
        messageLayoutTop += 300
        metrics.scrollHeight += 300
        observers.notifyResize()
        observers.flushFrames()

        expect(container.scrollTop).toBe(400)
        expect(message.getBoundingClientRect().top).toBe(20)
        release()
        controller.destroy()
    })

    it('preserves the first visible message while older history is prepended', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const visibleMessage = document.createElement('div')
        visibleMessage.className = 'chat-message-container'
        container.appendChild(visibleMessage)
        const metrics = { scrollHeight: 1200, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        let messageLayoutTop = 120
        visibleMessage.getBoundingClientRect = () => new DOMRect(
            0,
            messageLayoutTop - container.scrollTop,
            300,
            100,
        )
        const controller = createController(container)
        observers.flushFrames()
        container.scrollTop = 100
        container.dispatchEvent(new Event('scroll'))

        const release = controller.preserveViewportPosition()
        messageLayoutTop += 300
        metrics.scrollHeight += 300
        observers.notifyResize()
        observers.flushFrames()

        expect(container.scrollTop).toBe(400)
        expect(visibleMessage.getBoundingClientRect().top).toBe(20)
        release()
        controller.destroy()
    })

    it('uses positive targets for edges and elements', () => {
        installLayoutObservers()
        const container = document.createElement('div')
        const element = document.createElement('div')
        container.appendChild(element)
        const metrics = { scrollHeight: 1000, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        container.scrollTop = 300
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        element.getBoundingClientRect = () => new DOMRect(0, 400, 300, 100)
        const scrollTo = vi.fn()
        container.scrollTo = scrollTo
        const controller = createController(container)

        controller.scrollToElement(element, { block: 'start', behavior: 'instant' })
        controller.scrollToEdge('top', 'smooth')
        controller.scrollToEdge('bottom', 'smooth')

        expect(scrollTo).toHaveBeenNthCalledWith(1, { top: 700, behavior: 'instant' })
        expect(scrollTo).toHaveBeenNthCalledWith(2, { top: 0, behavior: 'smooth' })
        expect(scrollTo).toHaveBeenNthCalledWith(3, { top: 800, behavior: 'smooth' })
        controller.destroy()
    })

    it('retries exact navigation as the target gains scroll range', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const target = document.createElement('div')
        container.appendChild(target)
        const metrics = { scrollHeight: 600, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        let targetLayoutTop = 500
        target.getBoundingClientRect = () => new DOMRect(
            0,
            targetLayoutTop - container.scrollTop,
            300,
            100,
        )
        container.scrollTo = vi.fn((options: ScrollToOptions | number) => {
            const top = typeof options === 'number' ? options : options.top
            container.scrollTop = Math.min(Number(top), metrics.scrollHeight - metrics.clientHeight)
            container.dispatchEvent(new Event('scroll'))
        }) as typeof container.scrollTo
        const controller = createController(container)
        observers.flushFrames()

        controller.scrollToElement(target, {
            block: 'start',
            behavior: 'instant',
            followLayout: true,
        })
        expect(target.getBoundingClientRect().top).toBe(100)

        metrics.scrollHeight = 800
        observers.notifyResize()
        observers.flushFrames()
        expect(target.getBoundingClientRect().top).toBe(0)

        targetLayoutTop += 300
        metrics.scrollHeight += 300
        observers.notifyResize()
        observers.flushFrames()
        expect(target.getBoundingClientRect().top).toBe(0)

        container.dispatchEvent(new Event('pointerdown'))
        window.dispatchEvent(new Event('pointerup'))
        targetLayoutTop += 200
        metrics.scrollHeight += 200
        observers.notifyResize()
        observers.flushFrames()
        expect(target.getBoundingClientRect().top).toBe(200)
        controller.destroy()
    })

    it('navigates chronologically and ends at the bottom edge', () => {
        installLayoutObservers()
        const container = document.createElement('div')
        const current = document.createElement('div')
        const next = document.createElement('div')
        current.dataset.chatIndex = '0'
        next.dataset.chatIndex = '1'
        container.append(current, next)
        const metrics = { scrollHeight: 1000, clientHeight: 200 }
        setScrollMetrics(container, metrics)
        container.scrollTop = 300
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        current.getBoundingClientRect = () => new DOMRect(0, -100, 300, 300)
        next.getBoundingClientRect = () => new DOMRect(0, 400, 300, 100)
        const scrollTo = vi.fn()
        container.scrollTo = scrollTo
        const controller = createController(container)

        controller.navigateMessage('next', 'instant')
        expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: 'instant' })

        current.getBoundingClientRect = () => new DOMRect(0, -500, 300, 100)
        next.getBoundingClientRect = () => new DOMRect(0, -100, 300, 300)
        controller.navigateMessage('next', 'smooth')
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 800, behavior: 'smooth' })
        controller.destroy()
    })
})

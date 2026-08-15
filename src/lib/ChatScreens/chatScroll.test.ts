// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    calculateRangePixelPadding,
    createChatScrollController,
    didNewResponseStart,
    isColumnReverseScrolledToBottom,
    snapToDevicePixel,
    type ChatResponseSnapshot,
} from './chatScroll'

afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

function createController(container: HTMLElement) {
    const rangeSpacer = document.createElement('div')
    container.appendChild(rangeSpacer)
    document.body.appendChild(container)
    return createChatScrollController(container, rangeSpacer)
}

function installLayoutObservers() {
    let resizeCallback: ResizeObserverCallback | null = null
    let mutationCallback: MutationCallback | null = null
    const observedElements = new Set<Element>()
    const unobservedElements: Element[] = []
    class TestResizeObserver {
        constructor(callback: ResizeObserverCallback) {
            resizeCallback = callback
        }
        observe(element: Element) {
            observedElements.add(element)
        }
        unobserve(element: Element) {
            observedElements.delete(element)
            unobservedElements.push(element)
        }
        disconnect() {}
    }
    class TestMutationObserver {
        constructor(callback: MutationCallback) {
            mutationCallback = callback
        }
        observe() {}
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
        unobservedElements,
    }
}

function pointerEvent(type: string, clientY: number, pointerType = 'touch') {
    const event = new Event(type)
    Object.defineProperties(event, {
        clientY: { value: clientY },
        pointerType: { value: pointerType },
    })
    return event
}

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

describe('new response auto-scroll timing', () => {
    it('waits for content instead of scrolling when the empty placeholder appears', () => {
        const previous = responseSnapshot({
            messageKey: 'user-1',
            messageCount: 1,
            isCharacterResponse: false,
            hasContent: true,
        })
        const placeholder = responseSnapshot()

        expect(didNewResponseStart(previous, placeholder)).toBe(false)
        expect(didNewResponseStart(placeholder, {
            ...placeholder,
            hasContent: true,
        })).toBe(true)
    })

    it('recognizes an already-populated non-streaming response', () => {
        const previous = responseSnapshot({
            messageKey: 'user-1',
            messageCount: 1,
            isCharacterResponse: false,
            hasContent: true,
        })

        expect(didNewResponseStart(previous, responseSnapshot({ hasContent: true }))).toBe(true)
    })

    it('does not repeatedly scroll as more streaming content arrives', () => {
        const firstToken = responseSnapshot({ hasContent: true })
        expect(didNewResponseStart(firstToken, firstToken)).toBe(false)
    })

    it('ignores chat switches, edits, and continuation id changes', () => {
        const empty = responseSnapshot({ isResponding: false })
        expect(didNewResponseStart(empty, { ...empty, hasContent: true })).toBe(false)

        const populated = responseSnapshot({ hasContent: true })
        expect(didNewResponseStart(populated, {
            ...populated,
            roomKey: 'character:other-room',
        })).toBe(false)
        expect(didNewResponseStart(populated, {
            ...populated,
            messageKey: 'continuation-generation',
        })).toBe(false)
    })
})

describe('chat scroll pixel snapping', () => {
    it('snaps positive and negative offsets to the physical-pixel grid', () => {
        expect(snapToDevicePixel(10.26, 2)).toBe(10.5)
        expect(snapToDevicePixel(-10.26, 2)).toBe(-10.5)
        expect(snapToDevicePixel(-0.1, 2)).toBe(0)
    })

    it('pads a fractional scroll range up to the next physical pixel', () => {
        const range = 6967.283203125
        const padding = calculateRangePixelPadding(range, 1.2)

        expect(padding).toBeGreaterThan(0)
        expect(padding).toBeLessThan(1 / 1.2)
        expect((range + padding) * 1.2).toBeCloseTo(8361, 10)
    })

    it('does not add another pixel to an aligned range', () => {
        expect(calculateRangePixelPadding(100, 1.2)).toBe(0)
    })

    it('keeps mobile rubber-band overscroll pinned to the bottom edge', () => {
        expect(isColumnReverseScrolledToBottom(0)).toBe(true)
        expect(isColumnReverseScrolledToBottom(12)).toBe(true)
        expect(isColumnReverseScrolledToBottom(-10)).toBe(false)
    })

    it('quantizes the measured streaming message height with subpixel padding', () => {
        const messageHeight = 6409.06689453125
        const padding = calculateRangePixelPadding(messageHeight, 1.2)

        expect(padding).toBeGreaterThan(0)
        expect(padding).toBeLessThan(1 / 1.2)
        expect((messageHeight + padding) * 1.2).toBeCloseTo(7691, 10)
    })

    it('reuses the active streaming message instead of querying every resize', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const streamingMessage = document.createElement('div')
        streamingMessage.className = 'chat-message-container'
        streamingMessage.toggleAttribute('data-streaming-chat-message', true)
        container.appendChild(streamingMessage)
        const querySelector = vi.spyOn(container, 'querySelector')
        const controller = createController(container)

        observers.flushFrames()
        observers.notifyResize()
        observers.flushFrames()
        observers.notifyResize()
        observers.flushFrames()

        expect(querySelector).toHaveBeenCalledTimes(1)
        expect(streamingMessage.querySelector('[data-streaming-pixel-spacer]')).not.toBeNull()
        controller.destroy()
    })

    it('unobserves direct children after they leave the chat container', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const removedChild = document.createElement('div')
        const addedChild = document.createElement('div')
        container.appendChild(removedChild)
        const controller = createController(container)

        expect(observers.observedElements.has(removedChild)).toBe(true)
        removedChild.remove()
        container.appendChild(addedChild)
        observers.notifyMutation()

        expect(observers.unobservedElements).toContain(removedChild)
        expect(observers.observedElements.has(removedChild)).toBe(false)
        expect(observers.observedElements.has(addedChild)).toBe(true)
        controller.destroy()
    })

    it('does not write scrollTop while streaming layout grows during touch scrolling', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const anchor = document.createElement('div')
        anchor.className = 'chat-message-container'
        container.appendChild(anchor)
        container.scrollTop = -100
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        let anchorLayoutTop = -80
        anchor.getBoundingClientRect = () => new DOMRect(
            0,
            anchorLayoutTop - container.scrollTop,
            300,
            100,
        )
        const controller = createController(container)
        observers.flushFrames()

        container.dispatchEvent(new Event('touchstart'))
        container.dispatchEvent(new Event('pointerdown'))
        container.scrollTop = -125
        container.dispatchEvent(new Event('scroll'))
        // Native panning may cancel Pointer Events before the finger lifts.
        // touchActive must still prevent layout correction until touchend.
        window.dispatchEvent(new Event('pointercancel'))
        anchorLayoutTop -= 30
        observers.notifyResize()
        observers.flushFrames()

        expect(container.scrollTop).toBe(-125)
        expect(anchor.getBoundingClientRect().top).toBe(15)
        controller.destroy()
    })

    it('restores the bottom when mobile layout scrolling occurs under a resting touch', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        container.scrollTop = 0
        const controller = createController(container)
        observers.flushFrames()

        container.dispatchEvent(new Event('pointerdown'))
        // Mobile engines can move a reverse scroller when its bottom content
        // grows even though the user has not moved their finger.
        container.scrollTop = -24
        container.dispatchEvent(new Event('scroll'))
        observers.flushFrames()

        expect(container.scrollTop).toBe(-24)
        window.dispatchEvent(new Event('pointerup'))
        observers.flushFrames()
        expect(container.scrollTop).toBe(0)
        controller.destroy()
    })

    it('keeps the bottom latched after a touch gesture reaches it', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        container.scrollTop = -100
        const controller = createController(container)
        observers.flushFrames()

        container.dispatchEvent(pointerEvent('pointerdown', 100))
        window.dispatchEvent(pointerEvent('pointermove', 80))
        container.scrollTop = 0
        container.dispatchEvent(new Event('scroll'))

        // Simulate the streaming layout shifting scrollTop before the resize
        // observer restores the latest-message edge.
        container.scrollTop = -24
        container.dispatchEvent(new Event('scroll'))
        observers.flushFrames()

        expect(container.scrollTop).toBe(-24)
        window.dispatchEvent(new Event('pointerup'))
        observers.flushFrames()
        expect(container.scrollTop).toBe(0)
        controller.destroy()
    })

    it('releases the bottom latch when the finger moves back into history', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        container.scrollTop = 0
        const controller = createController(container)
        observers.flushFrames()

        container.dispatchEvent(pointerEvent('pointerdown', 100))
        window.dispatchEvent(pointerEvent('pointermove', 120))
        container.scrollTop = -24
        container.dispatchEvent(new Event('scroll'))
        observers.flushFrames()

        window.dispatchEvent(new Event('pointerup'))
        observers.flushFrames()
        expect(container.scrollTop).toBe(-24)
        controller.destroy()
    })

    it('keeps the exact fractional position published by a wheel scroll', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const anchor = document.createElement('div')
        anchor.className = 'chat-message-container'
        container.appendChild(anchor)
        container.scrollTop = -100
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        const anchorLayoutTop = -80
        anchor.getBoundingClientRect = () => new DOMRect(
            0,
            anchorLayoutTop - container.scrollTop,
            300,
            100,
        )
        const controller = createController(container)
        observers.flushFrames()

        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -0.25 }))
        container.scrollTop = -125.25
        container.dispatchEvent(new Event('scroll'))
        observers.notifyResize()
        observers.flushFrames()

        expect(container.scrollTop).toBe(-125.25)
        controller.destroy()
    })

    it('does not relatch the bottom when an upward wheel move is published late', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const anchor = document.createElement('div')
        anchor.className = 'chat-message-container'
        container.appendChild(anchor)
        container.scrollTop = 0
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        const anchorLayoutTop = -80
        anchor.getBoundingClientRect = () => new DOMRect(
            0,
            anchorLayoutTop - container.scrollTop,
            300,
            100,
        )
        const controller = createController(container)
        observers.flushFrames()

        // Firefox can expose the wheel event before its async scroll position.
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -24 }))
        // A stream chunk in that gap must not create a stale bottom anchor.
        observers.notifyResize()
        observers.flushFrames()
        container.scrollTop = -24
        container.dispatchEvent(new Event('scroll'))

        // The next streaming resize must accept the late user position instead
        // of applying the old bottom latch and writing scrollTop back to zero.
        observers.notifyResize()
        observers.flushFrames()

        expect(container.scrollTop).toBe(-24)
        controller.destroy()
    })

    it('rebases the anchor at every position emitted during wheel scrolling', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const anchor = document.createElement('div')
        anchor.className = 'chat-message-container'
        container.appendChild(anchor)
        container.scrollTop = -100
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        let anchorLayoutTop = -80
        anchor.getBoundingClientRect = () => new DOMRect(
            0,
            anchorLayoutTop - container.scrollTop,
            300,
            100,
        )
        const controller = createController(container)
        observers.flushFrames()

        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -24 }))
        container.scrollTop = -110
        container.dispatchEvent(new Event('scroll'))

        // Firefox can preserve the visible position while layout and APZ each
        // publish another value. The final scroll must replace the intermediate
        // anchor before the observer is allowed to correct anything.
        anchorLayoutTop -= 15
        container.scrollTop = -125
        container.dispatchEvent(new Event('scroll'))
        observers.notifyResize()
        observers.flushFrames()

        expect(container.scrollTop).toBe(-125)
        expect(anchor.getBoundingClientRect().top).toBe(30)
        controller.destroy()
    })

    it('preserves an anchor after layout without relying on a native scroll event', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const anchor = document.createElement('div')
        anchor.className = 'chat-message-container'
        container.appendChild(anchor)
        container.scrollTop = -100
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        let anchorLayoutTop = -80
        anchor.getBoundingClientRect = () => new DOMRect(
            0,
            anchorLayoutTop - container.scrollTop,
            300,
            100,
        )
        const controller = createController(container)
        observers.flushFrames()

        // Safari versions without native scroll anchoring do not move
        // scrollTop or emit scroll here; ResizeObserver must preserve it.
        anchorLayoutTop -= 30
        observers.notifyResize()
        observers.flushFrames()

        expect(container.scrollTop).toBe(-130)
        expect(anchor.getBoundingClientRect().top).toBe(20)
        controller.destroy()
    })

    it('does not scroll when the visible message itself grows upward', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const anchor = document.createElement('div')
        anchor.className = 'chat-message-container'
        container.appendChild(anchor)
        container.scrollTop = -100
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        const anchorLayoutBottom = 80
        let anchorHeight = 100
        anchor.getBoundingClientRect = () => new DOMRect(
            0,
            anchorLayoutBottom - anchorHeight - container.scrollTop,
            300,
            anchorHeight,
        )
        const controller = createController(container)
        observers.flushFrames()

        expect(anchor.getBoundingClientRect().bottom).toBe(180)
        anchorHeight = 500
        observers.notifyResize()
        observers.flushFrames()

        expect(container.scrollTop).toBe(-100)
        expect(anchor.getBoundingClientRect().bottom).toBe(180)
        controller.destroy()
    })

    it('keeps the pre-edit message anchor through intermediate layout scroll events', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const anchor = document.createElement('div')
        anchor.className = 'chat-message-container'
        container.appendChild(anchor)
        container.scrollTop = -100
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        let anchorLayoutTop = -80
        anchor.getBoundingClientRect = () => new DOMRect(
            0,
            anchorLayoutTop - container.scrollTop,
            300,
            100,
        )
        const controller = createController(container)
        observers.flushFrames()

        const release = controller.preserveElementPosition(anchor)
        anchorLayoutTop -= 300
        // Simulate native scroll anchoring reacting to the temporary 44px
        // editor before its auto-height measurement has completed.
        container.scrollTop = -150
        container.dispatchEvent(new Event('scroll'))
        observers.notifyResize()
        observers.flushFrames()

        expect(container.scrollTop).toBe(-400)
        expect(anchor.getBoundingClientRect().top).toBe(20)

        release()
        controller.destroy()
    })

    it('rebases a stale anchor whenever native scrolling publishes a newer position', () => {
        const observers = installLayoutObservers()
        const container = document.createElement('div')
        const anchor = document.createElement('div')
        anchor.className = 'chat-message-container'
        container.appendChild(anchor)
        container.scrollTop = -100
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        let anchorLayoutTop = -80
        anchor.getBoundingClientRect = () => new DOMRect(
            0,
            anchorLayoutTop - container.scrollTop,
            300,
            100,
        )
        const controller = createController(container)
        observers.flushFrames()

        // Firefox APZ can publish another position after a layout-induced
        // scroll. That newer coordinate must always replace the old anchor.
        container.scrollTop = -125
        container.dispatchEvent(new Event('scroll'))

        // Firefox then preserves that new visual position while streaming
        // content grows. The manual controller must not restore the old anchor.
        anchorLayoutTop -= 30
        container.scrollTop = -155
        container.dispatchEvent(new Event('scroll'))
        observers.notifyResize()
        observers.flushFrames()

        expect(container.scrollTop).toBe(-155)
        expect(anchor.getBoundingClientRect().top).toBe(45)
        controller.destroy()
    })

    it('snaps programmatic scroll targets derived from fractional DOMRects', () => {
        const container = document.createElement('div')
        const element = document.createElement('div')
        container.scrollTop = -20.25
        container.getBoundingClientRect = () => new DOMRect(0, 10.1, 300, 200)
        element.getBoundingClientRect = () => new DOMRect(0, 42.45, 300, 50)
        const scrollTo = vi.fn()
        container.scrollTo = scrollTo
        container.appendChild(element)
        const controller = createController(container)

        controller.scrollToElement(element, { block: 'start', behavior: 'instant' })

        const dpr = window.devicePixelRatio || 1
        const expectedTop = Math.round((-20.25 + 42.45 - 10.1) * dpr) / dpr
        expect(scrollTo).toHaveBeenCalledWith({ top: expectedTop, behavior: 'instant' })
        controller.destroy()
    })

    it('targets the exact clamped edges of a column-reverse chat', () => {
        const container = document.createElement('div')
        const scrollTo = vi.fn()
        Object.defineProperty(container, 'scrollHeight', { value: 8063 })
        container.scrollTo = scrollTo
        const controller = createController(container)

        controller.scrollToEdge('top', 'smooth')
        controller.scrollToEdge('bottom', 'smooth')

        expect(scrollTo).toHaveBeenNthCalledWith(1, { top: -8063, behavior: 'smooth' })
        expect(scrollTo).toHaveBeenNthCalledWith(2, { top: 0, behavior: 'smooth' })
        controller.destroy()
    })

    it('navigates down directly to the next message start', () => {
        const container = document.createElement('div')
        const current = document.createElement('div')
        const next = document.createElement('div')
        current.dataset.chatIndex = '0'
        next.dataset.chatIndex = '1'
        container.append(current, next)
        container.scrollTop = -300
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        current.getBoundingClientRect = () => new DOMRect(0, -100, 300, 500)
        next.getBoundingClientRect = () => new DOMRect(0, 400, 300, 100)
        const scrollTo = vi.fn()
        container.scrollTo = scrollTo
        const controller = createController(container)

        controller.navigateMessage('next', 'instant')

        expect(scrollTo).toHaveBeenCalledWith({ top: 100, behavior: 'instant' })
        controller.destroy()
    })

    it('navigates down to the bottom edge from the final message', () => {
        const container = document.createElement('div')
        const finalMessage = document.createElement('div')
        finalMessage.dataset.chatIndex = '0'
        container.appendChild(finalMessage)
        container.scrollTop = -300
        container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
        finalMessage.getBoundingClientRect = () => new DOMRect(0, -100, 300, 500)
        const scrollTo = vi.fn()
        container.scrollTo = scrollTo
        const controller = createController(container)

        controller.navigateMessage('next', 'smooth')

        expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
        controller.destroy()
    })
})

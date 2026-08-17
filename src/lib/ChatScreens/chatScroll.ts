// Chat scrolling uses an ordinary top-to-bottom coordinate system. Content
// appended below the reader does not move the viewport. At the bottom, a
// dedicated DOM scroll anchor follows streaming layout in the same paint;
// JavaScript handles explicit navigation and layout transitions only.

import { getPhysicalPixelQuantum } from 'src/ts/gui/physicalPixel'

const BOTTOM_EPSILON = 1
const SCROLL_PHASE_EPSILON = 1 / 120
const MESSAGE_NAVIGATION_THRESHOLD = 30
const LAYOUT_ELEMENT_SELECTOR = '.chat-message-container, .risu-chat'
const NATIVE_BOTTOM_ANCHOR_ATTRIBUTE = 'data-chat-scroll-anchor'
const SCROLL_PHASE_ATTRIBUTE = 'data-chat-scroll-phase'
const DIRECT_MANIPULATION_ATTRIBUTE = 'data-chat-direct-manipulation'
export const CHAT_NEAR_BOTTOM_THRESHOLD = 100
export const CHAT_HISTORY_LOAD_THRESHOLD = 100

type ChatScrollMode = 'bottom-follow' | 'history-read'

export function getScrollDistanceFromBottom(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
) {
    return Math.max(0, scrollHeight - clientHeight - scrollTop)
}

export function isChatScrolledToBottom(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    epsilon = BOTTOM_EPSILON,
) {
    return getScrollDistanceFromBottom(scrollTop, scrollHeight, clientHeight)
        <= Math.max(0, epsilon)
}

export function isChatNearBottom(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    threshold = CHAT_NEAR_BOTTOM_THRESHOLD,
) {
    return getScrollDistanceFromBottom(scrollTop, scrollHeight, clientHeight)
        <= Math.max(0, threshold)
}

export function getScrollPhaseQuantum(devicePixelRatio: number) {
    return getPhysicalPixelQuantum(devicePixelRatio)
}

export function normalizeScrollPhaseHeight(height: number, devicePixelRatio: number) {
    const quantum = getScrollPhaseQuantum(devicePixelRatio)
    const normalized = ((height % quantum) + quantum) % quantum
    return normalized > quantum - SCROLL_PHASE_EPSILON ? 0 : normalized
}

type ScrollElementOptions = {
    block: 'start' | 'end'
    behavior: ScrollBehavior
    followLayout?: boolean
}

type LayoutAnchor = {
    element: HTMLElement | null
    edge: 'top' | 'bottom'
    position: number
}

export type ChatScrollController = {
    scrollToElement(element: HTMLElement, options: ScrollElementOptions): void
    scrollToEdge(edge: 'top' | 'bottom', behavior: ScrollBehavior): void
    navigateMessage(direction: 'prev' | 'next', behavior?: ScrollBehavior): void
    preserveElementPosition(element: HTMLElement): () => void
    preserveViewportPosition(): () => void
    destroy(): void
}

export interface ChatResponseSnapshot {
    roomKey: string
    messageKey: string | null
    messageCount: number
    isCharacterResponse: boolean
    hasContent: boolean
    isResponding: boolean
}

/** Detect the instant a new assistant response finishes generating. */
export function didNewResponseComplete(
    previous: ChatResponseSnapshot | null,
    current: ChatResponseSnapshot,
): boolean {
    if (!previous
        || previous.roomKey !== current.roomKey
        || !current.isCharacterResponse
        || !current.messageKey
        || !current.hasContent
        || current.isResponding) {
        return false
    }

    if (previous.messageKey === current.messageKey) {
        return previous.isResponding
    }

    return current.messageCount > previous.messageCount
}

export type CompletedResponseAction = 'scroll' | 'notify' | 'none'

export function getCompletedResponseAction(options: {
    autoScroll: boolean
    alwaysScroll: boolean
    buttonEnabled: boolean
    nearBottom: boolean
}): CompletedResponseAction {
    if (options.nearBottom) return 'none'
    if (options.autoScroll && options.alwaysScroll) return 'scroll'
    if (options.buttonEnabled) return 'notify'
    return 'none'
}

export function createChatScrollController(
    container: HTMLElement,
): ChatScrollController {
    let destroyed = false
    let layoutFrame = 0
    let mode: ChatScrollMode = 'bottom-follow'
    let leavingBottom = false
    let pointerActive = false
    let touchActive = false
    let directManipulationStart: number | null = null
    let navigationAnchor: LayoutAnchor | null = null
    const layoutAnchors = new Map<symbol, LayoutAnchor>()
    const observedElements = new Set<Element>()

    const maxScrollTop = () => Math.max(0, container.scrollHeight - container.clientHeight)
    const isAtBottom = () => isChatScrolledToBottom(
        container.scrollTop,
        container.scrollHeight,
        container.clientHeight,
    )

    const latestLayoutAnchor = () => {
        const anchors = [...layoutAnchors.values()]
        return anchors.at(-1) ?? navigationAnchor
    }

    const directChildWithAttribute = (attribute: string) => Array.from(container.children)
        .find((element): element is HTMLElement => element instanceof HTMLElement
            && element.hasAttribute(attribute))

    const nativeBottomAnchor = () => directChildWithAttribute(NATIVE_BOTTOM_ANCHOR_ATTRIBUTE)
    const scrollPhaseElement = () => directChildWithAttribute(SCROLL_PHASE_ATTRIBUTE)

    const followsNativeBottomAnchor = () => mode === 'bottom-follow'
        && !latestLayoutAnchor()
        && Boolean(nativeBottomAnchor())
        && isAtBottom()

    const alignBottomPhase = () => {
        const phaseElement = scrollPhaseElement()
        const bottomAnchor = nativeBottomAnchor()
        if (!phaseElement || !bottomAnchor) return false

        if (maxScrollTop() <= 0) {
            if (phaseElement.getBoundingClientRect().height > SCROLL_PHASE_EPSILON) {
                phaseElement.style.height = '0px'
                return true
            }
            return false
        }

        // Firefox rasterizes the scrolled layer at its content-space physical
        // pixel phase. Keeping only the viewport rect stable is insufficient:
        // text and one-pixel lines still repaint on alternating device rows if
        // this phase changes. Align the content bottom itself to one physical
        // pixel, then let the scrollport clamp to the corresponding bottom.
        const containerRect = container.getBoundingClientRect()
        const contentBottom = bottomAnchor.getBoundingClientRect().bottom
            - containerRect.top
            + container.scrollTop
        const currentHeight = phaseElement.getBoundingClientRect().height
        const nextHeight = normalizeScrollPhaseHeight(
            currentHeight - contentBottom,
            globalThis.devicePixelRatio,
        )
        if (Math.abs(nextHeight - currentHeight) <= SCROLL_PHASE_EPSILON) return false
        phaseElement.style.height = `${nextHeight}px`
        return true
    }

    const scrollToActualBottom = () => {
        // scrollHeight/clientHeight are integer-valued, while Firefox's actual
        // clamped maximum can be fractional under browser zoom. Request past
        // the end and let the scrollport clamp to its real maximum.
        container.scrollTop = container.scrollHeight
    }

    const alignBottom = () => {
        alignBottomPhase()
        scrollToActualBottom()
    }

    const alignLayoutAnchor = (anchor: LayoutAnchor) => {
        if (anchor.edge === 'bottom') {
            alignBottom()
            return
        }
        if (!anchor.element?.isConnected || !container.contains(anchor.element)) return
        const delta = anchor.element.getBoundingClientRect().top - anchor.position
        if (Math.abs(delta) > Number.EPSILON) container.scrollTop += delta
    }

    const preserveAfterLayout = () => {
        if (destroyed || pointerActive || touchActive) return
        if (navigationAnchor?.element
            && (!navigationAnchor.element.isConnected
                || !container.contains(navigationAnchor.element))) {
            navigationAnchor = null
        }
        const anchor = latestLayoutAnchor()
        if (anchor) {
            alignLayoutAnchor(anchor)
            return
        }
        if (mode === 'bottom-follow') {
            alignBottom()
        }
    }

    const scheduleLayout = () => {
        if (destroyed) return
        cancelAnimationFrame(layoutFrame)
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = 0
            preserveAfterLayout()
        })
    }

    let resizeObserver: ResizeObserver | null = null
    const refreshResizeObservations = () => {
        if (!resizeObserver) return
        const nextElements = new Set<Element>([
            container,
            ...Array.from(container.children)
                .filter(element => !element.hasAttribute(SCROLL_PHASE_ATTRIBUTE)),
            ...container.querySelectorAll(LAYOUT_ELEMENT_SELECTOR),
        ])
        for (const element of observedElements) {
            if (nextElements.has(element)) continue
            resizeObserver.unobserve(element)
            observedElements.delete(element)
        }
        for (const element of nextElements) {
            if (observedElements.has(element)) continue
            observedElements.add(element)
            resizeObserver.observe(element)
        }
    }

    const handleWheel = (event: WheelEvent) => {
        navigationAnchor = null
        if (event.deltaY < 0) {
            leavingBottom = true
            mode = 'history-read'
        }
        else if (event.deltaY > 0) {
            leavingBottom = false
        }
    }

    const handleScroll = () => {
        if (layoutAnchors.size > 0 || navigationAnchor) return
        const atBottom = isAtBottom()
        // Firefox can deliver the wheel event before APZ publishes the first
        // changed scrollTop. Do not relatch during that gap.
        if (leavingBottom && atBottom) {
            mode = 'history-read'
            return
        }
        if (atBottom) {
            mode = 'bottom-follow'
            leavingBottom = false
            return
        }
        const directManipulationMoved = (pointerActive || touchActive)
            && directManipulationStart !== null
            && Math.abs(container.scrollTop - directManipulationStart) > BOTTOM_EPSILON
        if (leavingBottom || directManipulationMoved) {
            mode = 'history-read'
            leavingBottom = false
            return
        }
        // A forward-flow room can emit scroll while its initial/streamed
        // content is still publishing layout. Without explicit user intent,
        // that temporary bottom gap must not release the bottom latch.
        if (mode === 'bottom-follow') scheduleLayout()
    }

    const startDirectManipulation = () => {
        navigationAnchor = null
        directManipulationStart ??= container.scrollTop
        container.setAttribute(DIRECT_MANIPULATION_ATTRIBUTE, '')
    }
    const finishDirectManipulation = () => {
        if (pointerActive || touchActive) return
        container.removeAttribute(DIRECT_MANIPULATION_ATTRIBUTE)
        directManipulationStart = null
        scheduleLayout()
    }
    const startPointer = () => {
        startDirectManipulation()
        pointerActive = true
    }
    const endPointer = () => {
        pointerActive = false
        finishDirectManipulation()
    }
    const startTouch = () => {
        startDirectManipulation()
        touchActive = true
    }
    const endTouch = () => {
        touchActive = false
        finishDirectManipulation()
    }

    const scrollToElement = (element: HTMLElement, options: ScrollElementOptions) => {
        if (destroyed || !container.contains(element)) return
        const elementRect = element.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        const offset = options.block === 'start'
            ? elementRect.top - containerRect.top
            : elementRect.bottom - containerRect.bottom
        leavingBottom = false
        mode = 'history-read'
        navigationAnchor = options.followLayout
            ? {
                element,
                edge: 'top',
                position: options.block === 'start'
                    ? containerRect.top
                    : containerRect.bottom - elementRect.height,
            }
            : null
        container.scrollTo({
            top: container.scrollTop + offset,
            behavior: options.behavior,
        })
        if (navigationAnchor) scheduleLayout()
    }

    const scrollToEdge = (edge: 'top' | 'bottom', behavior: ScrollBehavior) => {
        if (destroyed) return
        leavingBottom = false
        navigationAnchor = null
        mode = edge === 'bottom' && behavior === 'instant'
            ? 'bottom-follow'
            : 'history-read'
        container.scrollTo({
            top: edge === 'bottom' ? maxScrollTop() : 0,
            behavior,
        })
    }

    const getLoadedMessages = () => Array.from(
        container.querySelectorAll<HTMLElement>('[data-chat-index]'),
    )
        .map(element => ({
            element,
            index: Number.parseInt(element.getAttribute('data-chat-index') ?? '', 10),
        }))
        .filter(message => Number.isFinite(message.index))
        .sort((a, b) => a.index - b.index)

    const navigateMessage = (
        direction: 'prev' | 'next',
        behavior: ScrollBehavior = 'smooth',
    ) => {
        if (destroyed) return
        const messages = getLoadedMessages()
        if (messages.length === 0) return

        const containerRect = container.getBoundingClientRect()
        let currentPosition = messages.findIndex(message =>
            message.element.getBoundingClientRect().bottom
                > containerRect.top + MESSAGE_NAVIGATION_THRESHOLD)
        if (currentPosition < 0) currentPosition = messages.length - 1

        if (direction === 'next') {
            const next = messages[currentPosition + 1]
            if (next) scrollToElement(next.element, { block: 'start', behavior })
            else scrollToEdge('bottom', behavior)
            return
        }

        const current = messages[currentPosition]
        const currentTop = current.element.getBoundingClientRect().top
        const target = currentTop < containerRect.top - MESSAGE_NAVIGATION_THRESHOLD
            ? current
            : messages[currentPosition - 1]
        if (target) scrollToElement(target.element, { block: 'start', behavior })
    }

    const preserveElementPosition = (element: HTMLElement) => {
        if (destroyed || !container.contains(element)) return () => {}
        const token = Symbol('chat-layout-anchor')
        const atBottom = isAtBottom()
        const anchor: LayoutAnchor = atBottom
            ? { element: null, edge: 'bottom', position: 0 }
            : {
                element,
                edge: 'top',
                position: element.getBoundingClientRect().top,
            }
        layoutAnchors.set(token, anchor)
        mode = atBottom ? 'bottom-follow' : 'history-read'

        let released = false
        return () => {
            if (released || destroyed) return
            released = true
            alignLayoutAnchor(anchor)
            layoutAnchors.delete(token)
            scheduleLayout()
        }
    }

    const preserveViewportPosition = () => {
        const containerRect = container.getBoundingClientRect()
        const visibleElement = Array.from(
            container.querySelectorAll<HTMLElement>(LAYOUT_ELEMENT_SELECTOR),
        ).find((element) => {
            const rect = element.getBoundingClientRect()
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom
        })
        return visibleElement ? preserveElementPosition(visibleElement) : () => {}
    }

    const handleObservedLayout = () => {
        // Mobile browser chrome can resize the visual viewport on every frame
        // of a touch gesture. Never let bottom-follow corrections compete with
        // the browser while the user is directly manipulating the scroller.
        if (destroyed || pointerActive || touchActive) return
        if (followsNativeBottomAnchor()) {
            // Native anchoring owns healthy streamed frames. JS only recovers
            // a fractional phase mismatch and otherwise performs no scroll
            // write, so the two mechanisms cannot fight over the same frame.
            if (alignBottomPhase()) scrollToActualBottom()
            return
        }
        scheduleLayout()
    }

    resizeObserver = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(handleObservedLayout)
    const mutationObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            refreshResizeObservations()
            handleObservedLayout()
        })

    refreshResizeObservations()
    mutationObserver?.observe(container, { childList: true, subtree: true })
    container.addEventListener('wheel', handleWheel, { passive: true })
    container.addEventListener('scroll', handleScroll, { passive: true })
    container.addEventListener('pointerdown', startPointer, { passive: true })
    container.addEventListener('touchstart', startTouch, { passive: true })
    window.addEventListener('pointerup', endPointer, { passive: true })
    window.addEventListener('pointercancel', endPointer, { passive: true })
    window.addEventListener('touchend', endTouch, { passive: true })
    window.addEventListener('touchcancel', endTouch, { passive: true })
    scheduleLayout()

    return {
        scrollToElement,
        scrollToEdge,
        navigateMessage,
        preserveElementPosition,
        preserveViewportPosition,
        destroy() {
            if (destroyed) return
            destroyed = true
            resizeObserver?.disconnect()
            mutationObserver?.disconnect()
            observedElements.clear()
            layoutAnchors.clear()
            directManipulationStart = null
            navigationAnchor = null
            container.removeAttribute(DIRECT_MANIPULATION_ATTRIBUTE)
            cancelAnimationFrame(layoutFrame)
            container.removeEventListener('wheel', handleWheel)
            container.removeEventListener('scroll', handleScroll)
            container.removeEventListener('pointerdown', startPointer)
            container.removeEventListener('touchstart', startTouch)
            window.removeEventListener('pointerup', endPointer)
            window.removeEventListener('pointercancel', endPointer)
            window.removeEventListener('touchend', endTouch)
            window.removeEventListener('touchcancel', endTouch)
        },
    }
}

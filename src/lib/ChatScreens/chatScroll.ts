// Chat scrolling uses an ordinary top-to-bottom coordinate system. Content
// appended below the reader does not move the viewport, so JavaScript only
// follows the bottom while latched and preserves explicit editor transitions.

const BOTTOM_EPSILON = 1
const MESSAGE_NAVIGATION_THRESHOLD = 30
const LAYOUT_ELEMENT_SELECTOR = '.chat-message-container, .risu-chat'
export const CHAT_NEAR_BOTTOM_THRESHOLD = 100
export const CHAT_HISTORY_LOAD_THRESHOLD = 100

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
    buttonEnabled: boolean
    nearBottom: boolean
}): CompletedResponseAction {
    if (options.nearBottom) return 'none'
    if (options.autoScroll) return 'scroll'
    if (options.buttonEnabled) return 'notify'
    return 'none'
}

export function createChatScrollController(
    container: HTMLElement,
): ChatScrollController {
    let destroyed = false
    let layoutFrame = 0
    let pinnedToBottom = true
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

    const alignLayoutAnchor = (anchor: LayoutAnchor) => {
        if (anchor.edge === 'bottom') {
            container.scrollTop = maxScrollTop()
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
        if (pinnedToBottom) container.scrollTop = maxScrollTop()
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
            ...container.children,
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
            pinnedToBottom = false
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
            pinnedToBottom = false
            return
        }
        if (atBottom) {
            pinnedToBottom = true
            leavingBottom = false
            return
        }
        const directManipulationMoved = (pointerActive || touchActive)
            && directManipulationStart !== null
            && Math.abs(container.scrollTop - directManipulationStart) > BOTTOM_EPSILON
        if (leavingBottom || directManipulationMoved) {
            pinnedToBottom = false
            leavingBottom = false
            return
        }
        // A forward-flow room can emit scroll while its initial/streamed
        // content is still publishing layout. Without explicit user intent,
        // that temporary bottom gap must not release the bottom latch.
        if (pinnedToBottom) scheduleLayout()
    }

    const startDirectManipulation = () => {
        navigationAnchor = null
        directManipulationStart ??= container.scrollTop
    }
    const finishDirectManipulation = () => {
        if (pointerActive || touchActive) return
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
        pinnedToBottom = false
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
        pinnedToBottom = edge === 'bottom' && behavior === 'instant'
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
        pinnedToBottom = atBottom

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

    resizeObserver = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleLayout)
    const mutationObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            refreshResizeObservations()
            scheduleLayout()
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

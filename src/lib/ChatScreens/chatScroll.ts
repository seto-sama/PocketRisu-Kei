// Chat scrolling is coordinated here because physical-pixel alignment and
// programmatic movement both write scrollTop. Keeping them in one controller
// prevents an alignment pass from fighting a button-triggered smooth scroll.

const POSITION_EPSILON = 0.0001
const MESSAGE_NAVIGATION_THRESHOLD = 30
const POINTER_DIRECTION_EPSILON = 0.5

function normalizedDevicePixelRatio(devicePixelRatio: number) {
    return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
        ? devicePixelRatio
        : 1
}

export function snapToDevicePixel(
    value: number,
    devicePixelRatio = window.devicePixelRatio || 1,
) {
    const ratio = normalizedDevicePixelRatio(devicePixelRatio)
    const snapped = Math.round(value * ratio) / ratio
    return Object.is(snapped, -0) ? 0 : snapped
}

/**
 * Return the smallest non-negative spacer that raises the scroll range to the
 * next physical-pixel boundary. The spacer is always less than one physical
 * pixel before the browser quantizes CSS layout coordinates.
 */
export function calculateRangePixelPadding(
    rangeWithoutPadding: number,
    devicePixelRatio: number,
) {
    if (!Number.isFinite(rangeWithoutPadding) || rangeWithoutPadding <= 0) return 0
    const ratio = normalizedDevicePixelRatio(devicePixelRatio)
    const physicalRange = rangeWithoutPadding * ratio
    // Avoid adding a whole extra pixel for ordinary floating-point residue.
    const targetPhysicalRange = Math.ceil(physicalRange - POSITION_EPSILON)
    return Math.max(0, (targetPhysicalRange - physicalRange) / ratio)
}

export function isColumnReverseScrolledToBottom(scrollTop: number) {
    // A column-reverse scroller moves towards negative scrollTop values when
    // navigating into history. Mobile WebKit may temporarily report a positive
    // value while rubber-banding past the latest-message edge, which is still
    // the bottom and must remain pinned while streaming content grows.
    return scrollTop >= -POSITION_EPSILON
}

type ScrollAnchor = {
    element: HTMLElement
    edge: 'top' | 'bottom' | 'scrollTop'
    position: number
}

type ScrollElementOptions = {
    block: 'start' | 'end'
    behavior: ScrollBehavior
}

export type ChatScrollController = {
    scrollToElement(element: HTMLElement, options: ScrollElementOptions): void
    scrollToEdge(edge: 'top' | 'bottom', behavior: ScrollBehavior): void
    navigateMessage(direction: 'prev' | 'next', behavior?: ScrollBehavior): void
    preserveElementPosition(element: HTMLElement): () => void
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

/** Detect the instant a new assistant response first becomes visible. */
export function didNewResponseStart(
    previous: ChatResponseSnapshot | null,
    current: ChatResponseSnapshot,
): boolean {
    if (!previous
        || previous.roomKey !== current.roomKey
        || !current.isCharacterResponse
        || !current.messageKey
        || !current.hasContent
        || (!previous.isResponding && !current.isResponding)) {
        return false
    }

    // Streaming fills an existing empty placeholder. Non-streaming providers
    // may instead append an already-populated response.
    if (previous.messageKey === current.messageKey) {
        return !previous.hasContent
    }

    // A continuation can replace the generation id of the current message;
    // only a larger message list represents a genuinely new response here.
    return current.messageCount > previous.messageCount
}

export function createChatScrollController(
    container: HTMLElement,
    rangeSpacer: HTMLElement,
): ChatScrollController {
    let destroyed = false
    let alignmentFrame = 0
    let anchor: ScrollAnchor | null = null
    let pinnedToBottom = isColumnReverseScrolledToBottom(container.scrollTop)
    let streamingMessage: HTMLElement | null = null
    let streamingHeightSpacer: HTMLDivElement | null = null
    let userMovingAwayFromBottom = false
    let lastPointerY: number | null = null
    let pointerActive = false
    let touchActive = false
    const layoutAnchorLocks = new Set<symbol>()
    const observedChildren = new Set<Element>()

    const getRatio = () => normalizedDevicePixelRatio(window.devicePixelRatio || 1)
    const isAtBottom = () => isColumnReverseScrolledToBottom(container.scrollTop)
    const isCorrectableDelta = (delta: number) => (
        Math.abs(delta) + POSITION_EPSILON >= 1 / getRatio()
    )
    const findVisibleAnchor = () => {
        const containerRect = container.getBoundingClientRect()
        let best: HTMLElement | null = null
        let bestTop = Number.POSITIVE_INFINITY

        for (const element of container.querySelectorAll<HTMLElement>('.chat-message-container')) {
            const rect = element.getBoundingClientRect()
            if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue
            if (rect.top < bestTop) {
                best = element
                bestTop = rect.top
            }
        }

        // The first greeting is rendered outside Chats and therefore has no
        // chat-message-container wrapper.
        if (!best) {
            for (const element of container.querySelectorAll<HTMLElement>('.risu-chat')) {
                const rect = element.getBoundingClientRect()
                if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue
                if (rect.top < bestTop) {
                    best = element
                    bestTop = rect.top
                }
            }
        }

        return best
    }

    const alignAnchor = () => {
        if (!anchor || !anchor.element.isConnected || !container.contains(anchor.element)) {
            anchor = null
            return false
        }

        if (anchor.edge === 'scrollTop') {
            if (isCorrectableDelta(container.scrollTop - anchor.position)) {
                container.scrollTop = anchor.position
            }
            return true
        }

        // A second pass absorbs the browser's own scroll-range clamping and
        // layout-unit rounding without spinning indefinitely.
        for (let pass = 0; pass < 2; pass++) {
            const rect = anchor.element.getBoundingClientRect()
            const currentPosition = anchor.edge === 'top' ? rect.top : rect.bottom
            const delta = currentPosition - anchor.position
            // Firefox quantizes scrollTop to physical-pixel steps. Writing a
            // smaller correction rounds to a whole step and can overshoot in
            // alternating directions as streamed content changes height.
            if (!isCorrectableDelta(delta)) break
            const previousScrollTop = container.scrollTop
            container.scrollTop = previousScrollTop + delta
            if (Math.abs(container.scrollTop - previousScrollTop) <= POSITION_EPSILON) break
        }
        return true
    }

    const captureAnchor = (snapToPixel: boolean) => {
        const element = findVisibleAnchor()
        if (!element) {
            anchor = null
            return false
        }
        const containerRect = container.getBoundingClientRect()
        const elementRect = element.getBoundingClientRect()
        const bottomIsVisible = elementRect.bottom >= containerRect.top
            && elementRect.bottom <= containerRect.bottom
        const topIsVisible = elementRect.top >= containerRect.top
            && elementRect.top <= containerRect.bottom
        const edge: ScrollAnchor['edge'] = bottomIsVisible
            ? 'bottom'
            : topIsVisible
                ? 'top'
                : 'scrollTop'
        const rawPosition = edge === 'scrollTop'
            ? container.scrollTop
            : edge === 'bottom'
                ? elementRect.bottom
                : elementRect.top
        anchor = {
            element,
            // Preserve a visible edge. If one long message spans the entire
            // viewport, neither edge represents what the reader is looking at;
            // keep the exact scroll offset instead of chasing an off-screen
            // edge and repeatedly snapping its fractional layout position.
            edge,
            position: snapToPixel && edge !== 'scrollTop'
                ? snapToDevicePixel(rawPosition, getRatio())
                : rawPosition,
        }
        return true
    }

    const establishAnchor = () => {
        if (!captureAnchor(true)) return
        alignAnchor()
    }

    const measureRangeWithoutPadding = () => {
        const containerTop = container.getBoundingClientRect().top + container.clientTop
        const spacerRect = rangeSpacer.getBoundingClientRect()
        // With column-reverse, rect.top + scrollTop is the spacer's invariant
        // position at the bottom origin, regardless of the current scroll.
        const rangeWithPadding = Math.max(
            0,
            containerTop - (spacerRect.top + container.scrollTop),
        )
        return Math.max(0, rangeWithPadding - spacerRect.height)
    }

    const alignStreamingMessageHeight = () => {
        const cachedStreamingMessageIsActive = !!streamingMessage
            && streamingMessage.isConnected
            && container.contains(streamingMessage)
            && streamingMessage.hasAttribute('data-streaming-chat-message')
            && !!streamingHeightSpacer?.isConnected
        const nextStreamingMessage = cachedStreamingMessageIsActive
            ? streamingMessage
            : container.querySelector<HTMLElement>(
                '.chat-message-container[data-streaming-chat-message]',
            )

        if (nextStreamingMessage
            && (nextStreamingMessage !== streamingMessage || !streamingHeightSpacer?.isConnected)) {
            streamingHeightSpacer?.remove()
            streamingMessage = nextStreamingMessage
            streamingHeightSpacer = document.createElement('div')
            streamingHeightSpacer.dataset.streamingPixelSpacer = ''
            streamingHeightSpacer.setAttribute('aria-hidden', 'true')
            streamingHeightSpacer.style.cssText = 'display:block;width:100%;height:0;pointer-events:none;'
            streamingMessage.appendChild(streamingHeightSpacer)
        }

        // Keep the final correction on the completed message until another
        // message starts streaming. Removing it at stream completion would
        // cause the exact fractional phase jump this spacer is preventing.
        if (!streamingMessage?.isConnected || !streamingHeightSpacer?.isConnected) {
            streamingMessage = null
            streamingHeightSpacer = null
            return
        }

        const spacerHeight = streamingHeightSpacer.getBoundingClientRect().height
        const rawMessageHeight = Math.max(
            0,
            streamingMessage.getBoundingClientRect().height - spacerHeight,
        )
        const padding = calculateRangePixelPadding(rawMessageHeight, getRatio())
        if (Math.abs(spacerHeight - padding) > POSITION_EPSILON) {
            streamingHeightSpacer.style.height = `${padding}px`
        }
    }

    const alignScrollRange = () => {
        const padding = calculateRangePixelPadding(measureRangeWithoutPadding(), getRatio())
        const currentHeight = rangeSpacer.getBoundingClientRect().height
        if (Math.abs(currentHeight - padding) > POSITION_EPSILON) {
            rangeSpacer.style.height = `${padding}px`
        }
    }

    const preserveAfterLayout = () => {
        // Direct manipulation can run off the main thread on mobile. Defer
        // writes until the finger or scrollbar thumb is released; wheel and
        // programmatic movement instead rebase from every emitted scroll.
        if (destroyed || pointerActive || touchActive) return

        if (pinnedToBottom) {
            // Keep the total range aligned in every scroll state so moving
            // away from the bottom never changes the rasterization phase. The
            // browser already holds an idle column-reverse scroller at zero;
            // only write when layout or touch scrolling actually displaced it.
            alignScrollRange()
            if (!isAtBottom()) container.scrollTop = 0
            anchor = null
            return
        }

        const hadAnchor = alignAnchor()
        alignStreamingMessageHeight()
        if (hadAnchor) alignAnchor()
        alignScrollRange()
        if (hadAnchor) alignAnchor()
        // Firefox can publish an upward wheel position after the next layout
        // frame. Do not establish a pre-wheel anchor during that short gap.
        else if (!userMovingAwayFromBottom) establishAnchor()
    }

    const scheduleAlignment = () => {
        if (destroyed) return
        cancelAnimationFrame(alignmentFrame)
        alignmentFrame = requestAnimationFrame(() => {
            alignmentFrame = 0
            preserveAfterLayout()
        })
    }

    const prepareForMovement = () => {
        layoutAnchorLocks.clear()
        userMovingAwayFromBottom = false
        lastPointerY = null
        anchor = null
        cancelAnimationFrame(alignmentFrame)
        alignmentFrame = 0
    }

    const startPointerGesture = (event: PointerEvent) => {
        layoutAnchorLocks.clear()
        pointerActive = true
        userMovingAwayFromBottom = false
        lastPointerY = event.clientY
    }

    const startTouchGesture = () => {
        layoutAnchorLocks.clear()
        touchActive = true
    }

    const handlePointerMove = (event: PointerEvent) => {
        if (!pointerActive) return
        if (lastPointerY !== null) {
            const deltaY = event.clientY - lastPointerY
            if (Math.abs(deltaY) > POINTER_DIRECTION_EPSILON) {
                // Touch content follows the finger: dragging down moves a
                // column-reverse chat away from its bottom. A mouse dragging
                // the scrollbar thumb has the opposite physical direction.
                userMovingAwayFromBottom = event.pointerType === 'mouse'
                    ? deltaY < 0
                    : deltaY > 0
                if (userMovingAwayFromBottom) {
                    pinnedToBottom = false
                    anchor = null
                }
            }
        }
        lastPointerY = event.clientY
    }

    const endPointerGesture = () => {
        pointerActive = false
        lastPointerY = null
        if (!touchActive) {
            userMovingAwayFromBottom = false
            scheduleAlignment()
        }
    }
    const endTouchGesture = () => {
        touchActive = false
        if (!pointerActive) {
            userMovingAwayFromBottom = false
            scheduleAlignment()
        }
    }
    const handleWheel = (event: WheelEvent) => {
        layoutAnchorLocks.clear()
        cancelAnimationFrame(alignmentFrame)
        alignmentFrame = 0
        anchor = null
        userMovingAwayFromBottom = event.deltaY < 0
        if (userMovingAwayFromBottom) pinnedToBottom = false
    }

    const handleScroll = () => {
        // Replacing rendered message content with an auto-sized editor can
        // make the browser publish an intermediate scroll position. Keep the
        // pre-edit anchor authoritative until that short layout transaction
        // has settled. Explicit pointer/wheel/programmatic movement clears the
        // lock above so user intent always wins.
        if (layoutAnchorLocks.size > 0) {
            if (pinnedToBottom) anchor = null
            return
        }

        const atBottom = isAtBottom()
        if (atBottom) {
            // An upward wheel can precede Firefox APZ's first off-bottom
            // position. Preserve that intent rather than latching a stale 0.
            pinnedToBottom = !userMovingAwayFromBottom
            anchor = null
            return
        }

        // A reverse scroller can move because bottom content grew while a
        // finger is resting. Keep the bottom latch unless the gesture itself
        // has actually moved towards history.
        if ((pointerActive || touchActive)
            && pinnedToBottom
            && !userMovingAwayFromBottom) {
            anchor = null
            return
        }

        // Every native or programmatic scroll position is authoritative. This
        // also rebases after browser-native anchoring, so a later observer pass
        // cannot restore an older point from the same gesture.
        pinnedToBottom = false
        captureAnchor(false)
        if (!pointerActive && !touchActive) userMovingAwayFromBottom = false
    }

    const scrollToElement = (element: HTMLElement, options: ScrollElementOptions) => {
        if (destroyed || !container.contains(element)) return
        const elementRect = element.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        const offset = options.block === 'start'
            ? elementRect.top - containerRect.top
            : elementRect.bottom - containerRect.bottom
        const top = snapToDevicePixel(container.scrollTop + offset, getRatio())
        prepareForMovement()
        pinnedToBottom = isColumnReverseScrolledToBottom(top)
        // scrollIntoView would also scroll ancestors such as documentElement.
        container.scrollTo({ top, behavior: options.behavior })
    }

    const scrollToEdge = (edge: 'top' | 'bottom', behavior: ScrollBehavior) => {
        if (destroyed) return
        prepareForMovement()
        pinnedToBottom = edge === 'bottom'
        // The chat uses column-reverse: the latest-message edge is 0 and the
        // oldest-message edge is negative. Let the browser clamp the oversized
        // negative target to the exact fractional upper boundary.
        container.scrollTo({
            top: edge === 'bottom' ? 0 : -container.scrollHeight,
            behavior,
        })
    }

    const getLoadedMessages = () => Array.from(container.querySelectorAll<HTMLElement>('[data-chat-index]'))
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
        let currentPosition = 0
        for (let position = 0; position < messages.length; position++) {
            if (messages[position].element.getBoundingClientRect().bottom
                > containerRect.top + MESSAGE_NAVIGATION_THRESHOLD) {
                currentPosition = position
                break
            }
        }

        if (direction === 'next') {
            // Message starts are the only stops; a long message's bottom is
            // deliberately not an intermediate navigation target.
            const next = messages[currentPosition + 1]
            if (next) {
                scrollToElement(next.element, { block: 'start', behavior })
            }
            else {
                // At the final message, match the dedicated bottom-edge button.
                scrollToEdge('bottom', behavior)
            }
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

        const lock = Symbol('chat-layout-anchor')
        layoutAnchorLocks.add(lock)
        if (isAtBottom()) {
            pinnedToBottom = true
            anchor = null
        }
        else {
            pinnedToBottom = false
            anchor = {
                element,
                // Explicit editor transitions preserve the element's top;
                // unlike automatic chat anchoring, callers intentionally ask
                // to hold this exact element in place while its UI changes.
                edge: 'top',
                position: element.getBoundingClientRect().top,
            }
        }

        let released = false
        return () => {
            if (released || destroyed) return
            released = true
            layoutAnchorLocks.delete(lock)
            scheduleAlignment()
        }
    }

    const resizeObserver = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => scheduleAlignment())
    const observeDirectChildren = () => {
        if (!resizeObserver) return
        const currentChildren = new Set(
            Array.from(container.children).filter(child => child !== rangeSpacer),
        )
        for (const child of observedChildren) {
            if (currentChildren.has(child)) continue
            resizeObserver.unobserve(child)
            observedChildren.delete(child)
        }
        for (const child of container.children) {
            if (child === rangeSpacer || observedChildren.has(child)) continue
            observedChildren.add(child)
            resizeObserver.observe(child)
        }
    }
    const mutationObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            observeDirectChildren()
            scheduleAlignment()
        })

    resizeObserver?.observe(container)
    observeDirectChildren()
    mutationObserver?.observe(container, { childList: true })
    container.addEventListener('pointerdown', startPointerGesture, { passive: true })
    container.addEventListener('touchstart', startTouchGesture, { passive: true })
    window.addEventListener('pointermove', handlePointerMove, { passive: true })
    window.addEventListener('pointerup', endPointerGesture, { passive: true })
    window.addEventListener('pointercancel', endPointerGesture, { passive: true })
    window.addEventListener('touchend', endTouchGesture, { passive: true })
    window.addEventListener('touchcancel', endTouchGesture, { passive: true })
    container.addEventListener('wheel', handleWheel, { passive: true })
    container.addEventListener('scroll', handleScroll, { passive: true })
    scheduleAlignment()

    return {
        scrollToElement,
        scrollToEdge,
        navigateMessage,
        preserveElementPosition,
        destroy() {
            if (destroyed) return
            destroyed = true
            resizeObserver?.disconnect()
            mutationObserver?.disconnect()
            observedChildren.clear()
            layoutAnchorLocks.clear()
            cancelAnimationFrame(alignmentFrame)
            container.removeEventListener('pointerdown', startPointerGesture)
            container.removeEventListener('touchstart', startTouchGesture)
            window.removeEventListener('pointermove', handlePointerMove)
            window.removeEventListener('pointerup', endPointerGesture)
            window.removeEventListener('pointercancel', endPointerGesture)
            window.removeEventListener('touchend', endTouchGesture)
            window.removeEventListener('touchcancel', endTouchGesture)
            container.removeEventListener('wheel', handleWheel)
            container.removeEventListener('scroll', handleScroll)
            streamingHeightSpacer?.remove()
            rangeSpacer.style.height = '0px'
        },
    }
}

// Chat scrolling is coordinated here because physical-pixel alignment and
// programmatic movement both write scrollTop. Keeping them in one controller
// prevents an alignment pass from fighting a button-triggered smooth scroll.

const POSITION_EPSILON = 0.0001
const INTERACTION_SETTLE_MS = 120
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
    top: number
}

type ScrollInteractionMode = 'idle' | 'user' | 'programmatic'

type ScrollElementOptions = {
    block: 'start' | 'end'
    behavior: ScrollBehavior
}

export type ChatScrollController = {
    scrollToElement(element: HTMLElement, options: ScrollElementOptions): void
    scrollToEdge(edge: 'top' | 'bottom', behavior: ScrollBehavior): void
    navigateMessage(direction: 'prev' | 'next', behavior?: ScrollBehavior): void
    destroy(): void
}

export function createChatScrollController(
    container: HTMLElement,
    rangeSpacer: HTMLElement,
): ChatScrollController {
    let destroyed = false
    let interactionMode: ScrollInteractionMode = 'idle'
    let interactionEndTimer: ReturnType<typeof setTimeout> | null = null
    let alignmentFrame = 0
    let anchor: ScrollAnchor | null = null
    let pinnedToBottom = isColumnReverseScrolledToBottom(container.scrollTop)
    let streamingMessage: HTMLElement | null = null
    let streamingHeightSpacer: HTMLDivElement | null = null
    let bottomReachedDuringInteraction = false
    let userMovingAwayFromBottom = false
    let lastPointerY: number | null = null
    let pointerActive = false
    let touchActive = false
    const observedChildren = new Set<Element>()

    const getRatio = () => normalizedDevicePixelRatio(window.devicePixelRatio || 1)
    const isAtBottom = () => isColumnReverseScrolledToBottom(container.scrollTop)

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

        // A second pass absorbs the browser's own scroll-range clamping and
        // layout-unit rounding without spinning indefinitely.
        for (let pass = 0; pass < 2; pass++) {
            const currentTop = anchor.element.getBoundingClientRect().top
            const delta = currentTop - anchor.top
            if (Math.abs(delta) <= POSITION_EPSILON) break
            const previousScrollTop = container.scrollTop
            container.scrollTop = previousScrollTop + delta
            if (Math.abs(container.scrollTop - previousScrollTop) <= POSITION_EPSILON) break
        }
        return true
    }

    const establishAnchor = () => {
        const element = findVisibleAnchor()
        if (!element) {
            anchor = null
            return
        }
        anchor = {
            element,
            top: snapToDevicePixel(element.getBoundingClientRect().top, getRatio()),
        }
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
        // Never write scrollTop while a wheel, touch/kinetic gesture, or smooth
        // programmatic scroll is active. Mobile scrolling runs off the main
        // thread, so layout correction here would fight the native scroller.
        if (destroyed || interactionMode !== 'idle') return

        if (pinnedToBottom) {
            alignStreamingMessageHeight()
            alignScrollRange()
            container.scrollTop = 0
            anchor = null
            return
        }

        const hadAnchor = alignAnchor()
        alignStreamingMessageHeight()
        if (hadAnchor) alignAnchor()
        alignScrollRange()
        if (hadAnchor) alignAnchor()
        else establishAnchor()
    }

    const settleAtCurrentPosition = () => {
        if (destroyed) return
        pinnedToBottom = bottomReachedDuringInteraction || isAtBottom()
        bottomReachedDuringInteraction = false
        if (pinnedToBottom) {
            alignStreamingMessageHeight()
            alignScrollRange()
            container.scrollTop = 0
            anchor = null
        }
        else {
            alignStreamingMessageHeight()
            alignScrollRange()
            establishAnchor()
        }
        userMovingAwayFromBottom = false
        lastPointerY = null
    }

    const scheduleAlignment = (settlePosition = false) => {
        if (destroyed || interactionMode !== 'idle') return
        cancelAnimationFrame(alignmentFrame)
        alignmentFrame = requestAnimationFrame(() => {
            alignmentFrame = 0
            if (settlePosition) settleAtCurrentPosition()
            else preserveAfterLayout()
        })
    }

    const finishInteraction = () => {
        interactionMode = 'idle'
        if (interactionEndTimer) {
            clearTimeout(interactionEndTimer)
            interactionEndTimer = null
        }
        scheduleAlignment(true)
    }

    const deferInteractionEnd = () => {
        if (interactionEndTimer) clearTimeout(interactionEndTimer)
        // A pause between touch movements is not the end of the gesture. Wait
        // for pointerup before using the timer to cover kinetic scrolling.
        if (interactionMode === 'user' && (pointerActive || touchActive)) {
            interactionEndTimer = null
            return
        }
        interactionEndTimer = setTimeout(finishInteraction, INTERACTION_SETTLE_MS)
    }

    const startInteraction = (mode: Exclude<ScrollInteractionMode, 'idle'>) => {
        interactionMode = mode
        bottomReachedDuringInteraction = isAtBottom()
        userMovingAwayFromBottom = false
        lastPointerY = null
        anchor = null
        cancelAnimationFrame(alignmentFrame)
        alignmentFrame = 0
        if (interactionEndTimer) {
            clearTimeout(interactionEndTimer)
            interactionEndTimer = null
        }
    }

    const startPointerGesture = (event: PointerEvent) => {
        startInteraction('user')
        pointerActive = true
        lastPointerY = event.clientY
    }

    const startTouchGesture = () => {
        touchActive = true
    }

    const handlePointerMove = (event: PointerEvent) => {
        if (interactionMode !== 'user') return
        if (lastPointerY !== null) {
            const deltaY = event.clientY - lastPointerY
            if (Math.abs(deltaY) > POINTER_DIRECTION_EPSILON) {
                // Touch content follows the finger: dragging down moves a
                // column-reverse chat away from its bottom. A mouse dragging
                // the scrollbar thumb has the opposite physical direction.
                userMovingAwayFromBottom = event.pointerType === 'mouse'
                    ? deltaY < 0
                    : deltaY > 0
            }
        }
        lastPointerY = event.clientY
    }

    const startProgrammaticScroll = () => {
        pointerActive = false
        startInteraction('programmatic')
        // Instant/no-op scrolls may not emit scrollend; ordinary scroll events
        // keep extending this fallback while a smooth scroll is in progress.
        deferInteractionEnd()
    }

    const endPointerGesture = () => {
        pointerActive = false
        lastPointerY = null
        if (interactionMode === 'user') deferInteractionEnd()
    }
    const endTouchGesture = () => {
        touchActive = false
        if (interactionMode === 'user') deferInteractionEnd()
    }
    const handleWheel = (event: WheelEvent) => {
        pointerActive = false
        startInteraction('user')
        userMovingAwayFromBottom = event.deltaY < 0
        deferInteractionEnd()
    }
    const handleScroll = () => {
        if (interactionMode === 'user') {
            if (isAtBottom()) bottomReachedDuringInteraction = true
            else if (userMovingAwayFromBottom) bottomReachedDuringInteraction = false
            deferInteractionEnd()
        }
        else if (interactionMode === 'programmatic') {
            if (isAtBottom()) bottomReachedDuringInteraction = true
            deferInteractionEnd()
        }
    }
    const handleScrollEnd = () => {
        if (interactionMode === 'user' && (pointerActive || touchActive)) return
        // Samsung Browser can emit a scrollend from the button's pointer
        // sequence immediately after a new smooth programmatic scroll starts.
        // Wait for the last real scroll event instead of restoring the anchor
        // on that stale event, which would cancel the animation at frame one.
        if (interactionMode === 'programmatic') {
            deferInteractionEnd()
            return
        }
        finishInteraction()
    }

    const scrollToElement = (element: HTMLElement, options: ScrollElementOptions) => {
        if (destroyed || !container.contains(element)) return
        const elementRect = element.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        const offset = options.block === 'start'
            ? elementRect.top - containerRect.top
            : elementRect.bottom - containerRect.bottom
        const top = snapToDevicePixel(container.scrollTop + offset, getRatio())
        startProgrammaticScroll()
        // scrollIntoView would also scroll ancestors such as documentElement.
        container.scrollTo({ top, behavior: options.behavior })
    }

    const scrollToEdge = (edge: 'top' | 'bottom', behavior: ScrollBehavior) => {
        if (destroyed) return
        startProgrammaticScroll()
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
    container.addEventListener('scrollend', handleScrollEnd)
    scheduleAlignment(true)

    return {
        scrollToElement,
        scrollToEdge,
        navigateMessage,
        destroy() {
            if (destroyed) return
            destroyed = true
            resizeObserver?.disconnect()
            mutationObserver?.disconnect()
            observedChildren.clear()
            cancelAnimationFrame(alignmentFrame)
            if (interactionEndTimer) clearTimeout(interactionEndTimer)
            container.removeEventListener('pointerdown', startPointerGesture)
            container.removeEventListener('touchstart', startTouchGesture)
            window.removeEventListener('pointermove', handlePointerMove)
            window.removeEventListener('pointerup', endPointerGesture)
            window.removeEventListener('pointercancel', endPointerGesture)
            window.removeEventListener('touchend', endTouchGesture)
            window.removeEventListener('touchcancel', endTouchGesture)
            container.removeEventListener('wheel', handleWheel)
            container.removeEventListener('scroll', handleScroll)
            container.removeEventListener('scrollend', handleScrollEnd)
            streamingHeightSpacer?.remove()
            rangeSpacer.style.height = '0px'
        },
    }
}

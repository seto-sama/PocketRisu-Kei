export const CHAT_SCROLL_ROOT_SELECTOR = '[data-chat-scroll-root]'
export const CHAT_VIEWPORT_MARGIN_MULTIPLIER = 1

type ViewportCallback = (target: Element, visible: boolean) => void
type Subscription = {
    callback: ViewportCallback
    once: boolean
}
type ObserverRecord = {
    callbacks: Map<Element, Set<Subscription>>
    observer: IntersectionObserver | null
    observedHeight: number
    removeResizeListeners: () => void
}

const viewportObservers = new WeakMap<HTMLElement, ObserverRecord>()

function createObserverFrameScheduler(callback: () => void) {
    let frame: number | null = null
    return {
        schedule() {
            if (frame !== null) return
            frame = requestAnimationFrame(() => {
                frame = null
                callback()
            })
        },
        cancel() {
            if (frame === null) return
            cancelAnimationFrame(frame)
            frame = null
        },
    }
}

function destroyObserverRecord(root: HTMLElement, record: ObserverRecord): void {
    if (viewportObservers.get(root) !== record) return
    record.observer?.disconnect()
    record.removeResizeListeners()
    viewportObservers.delete(root)
}

function dispatchEntries(
    root: HTMLElement,
    record: ObserverRecord,
    entries: IntersectionObserverEntry[],
): void {
    for (const entry of entries) {
        const subscriptions = record.callbacks.get(entry.target)
        if (!subscriptions) continue
        for (const subscription of [...subscriptions]) {
            if (subscription.once && !entry.isIntersecting) continue
            subscription.callback(entry.target, entry.isIntersecting)
            if (subscription.once && entry.isIntersecting) subscriptions.delete(subscription)
        }
        if (subscriptions.size === 0) {
            record.callbacks.delete(entry.target)
            record.observer?.unobserve(entry.target)
        }
    }
    if (record.callbacks.size === 0) destroyObserverRecord(root, record)
}

/**
 * Observe elements relative to the shared chat scroller. One-shot consumers
 * (such as inlay preloading) and persistent consumers (such as custom-theme
 * visibility) share the same observer and resize lifecycle.
 */
export function observeWithinChatViewport(
    targets: readonly Element[],
    callback: ViewportCallback,
    options: { once?: boolean } = {},
): () => void {
    if (targets.length === 0) return () => {}
    const once = options.once ?? true
    const chatRoot = targets[0].closest(CHAT_SCROLL_ROOT_SELECTOR) as HTMLElement | null

    if (!chatRoot) {
        const subscriptions = new Map<Element, Subscription>(targets.map(target => [
            target,
            { callback, once },
        ]))
        const viewportHeight = Math.max(1, globalThis.innerHeight ?? 1) * CHAT_VIEWPORT_MARGIN_MULTIPLIER
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const subscription = subscriptions.get(entry.target)
                if (!subscription || (subscription.once && !entry.isIntersecting)) continue
                subscription.callback(entry.target, entry.isIntersecting)
                if (subscription.once && entry.isIntersecting) {
                    subscriptions.delete(entry.target)
                    observer.unobserve(entry.target)
                }
            }
            if (subscriptions.size === 0) observer.disconnect()
        }, { rootMargin: `${viewportHeight}px 0px` })
        for (const target of targets) observer.observe(target)
        return () => observer.disconnect()
    }

    let record = viewportObservers.get(chatRoot)
    if (!record) {
        record = {
            callbacks: new Map(),
            observer: null,
            observedHeight: -1,
            removeResizeListeners: () => {},
        }
        const activeRecord = record
        const rebuildObserver = () => {
            const viewportHeight = Math.max(1, chatRoot.clientHeight) * CHAT_VIEWPORT_MARGIN_MULTIPLIER
            if (activeRecord.observer && activeRecord.observedHeight === viewportHeight) return
            activeRecord.observer?.disconnect()
            activeRecord.observedHeight = viewportHeight
            activeRecord.observer = new IntersectionObserver((entries) => {
                dispatchEntries(chatRoot, activeRecord, entries)
            }, {
                root: chatRoot,
                rootMargin: `${viewportHeight}px 0px`,
            })
            for (const target of activeRecord.callbacks.keys()) {
                activeRecord.observer.observe(target)
            }
        }
        const scheduler = createObserverFrameScheduler(rebuildObserver)
        window.addEventListener('resize', scheduler.schedule)
        globalThis.visualViewport?.addEventListener('resize', scheduler.schedule)
        activeRecord.removeResizeListeners = () => {
            window.removeEventListener('resize', scheduler.schedule)
            globalThis.visualViewport?.removeEventListener('resize', scheduler.schedule)
            scheduler.cancel()
        }
        viewportObservers.set(chatRoot, activeRecord)
        rebuildObserver()
    }

    const subscriptions: Array<[Element, Subscription]> = targets.map(target => {
        const subscription = { callback, once }
        const targetSubscriptions = record.callbacks.get(target) ?? new Set<Subscription>()
        targetSubscriptions.add(subscription)
        record.callbacks.set(target, targetSubscriptions)
        record.observer?.observe(target)
        return [target, subscription]
    })

    return () => {
        for (const [target, subscription] of subscriptions) {
            const targetSubscriptions = record?.callbacks.get(target)
            targetSubscriptions?.delete(subscription)
            if (targetSubscriptions?.size === 0) {
                record?.callbacks.delete(target)
                record?.observer?.unobserve(target)
            }
        }
        if (record?.callbacks.size !== 0 || viewportObservers.get(chatRoot) !== record) return
        destroyObserverRecord(chatRoot, record)
    }
}

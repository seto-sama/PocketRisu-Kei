import Sortable, { type MoveEvent, type Options, type SortableEvent } from 'sortablejs'
import type { folder } from 'src/ts/storage/database.svelte'
import { snapCssLengthToPhysicalPixel } from 'src/ts/gui/physicalPixel'

export const SIDEBAR_SORTABLE_GROUP = 'sidebar-characters'
export const SIDEBAR_ROOT_ITEM_SIZE = 56
export const SIDEBAR_FOLDER_ITEM_SIZE = 48
export const SIDEBAR_DEFAULT_FOLDER_NAME = 'New Folder'

const ITEM_SELECTOR = ':scope > [data-sidebar-order-key]'
const LIST_SELECTOR = '[data-risu-sortable-list]'
const DRAG_SIZE_PROPERTY = '--sidebar-drag-size'
const FALLBACK_CLASS = 'sidebar-sortable-fallback'
const INVERTED_SWAP_THRESHOLD = 0.4
const DROP_EDGE_RATIO = INVERTED_SWAP_THRESHOLD / 2
const DRAG_SIZE_DURATION = 120
const REORDER_DURATION = 150
const POSITION_EPSILON = 0.001

export type SidebarOrder = Array<string | folder>
export type SidebarDropTarget = {
    kind: 'merge' | 'folder'
    id: string
}

type PointerPosition = { clientX: number; clientY: number }
type SortableEventWithPointer = SortableEvent & { originalEvent?: Event }
type ElementPosition = { left: number; top: number }
type RelativeStyle = { position: string; left: string; top: string }

function directSortableItems(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>(ITEM_SELECTOR))
}

function validPointer(clientX: number | undefined, clientY: number | undefined): PointerPosition | null {
    return Number.isFinite(clientX) && Number.isFinite(clientY)
        ? { clientX: clientX!, clientY: clientY! }
        : null
}

function eventPointer(event: Event | undefined): PointerPosition | null {
    if (!event) return null
    if ('changedTouches' in event || 'touches' in event) {
        const touchEvent = event as TouchEvent
        const touch = touchEvent.changedTouches?.[0] ?? touchEvent.touches?.[0]
        return touch ? validPointer(touch.clientX, touch.clientY) : null
    }
    const pointer = event as MouseEvent | PointerEvent
    return validPointer(pointer.clientX, pointer.clientY)
}

export function findSidebarDropTarget(
    container: HTMLElement | undefined,
    sourceId: string | null,
    clientX: number | undefined,
    clientY: number | undefined,
): SidebarDropTarget | null {
    const pointer = validPointer(clientX, clientY)
    if (!container || !sourceId || !pointer) return null

    for (const child of directSortableItems(container)) {
        const targetId = child.dataset.sidebarOrderKey
        const targetKind = child.dataset.sidebarKind
        if (!targetId || targetId === sourceId || (targetKind !== 'character' && targetKind !== 'folder')) continue

        const target = child.querySelector<HTMLElement>('.avatar') ?? child
        const rect = target.getBoundingClientRect()
        const withinHorizontalBounds = pointer.clientX >= rect.left && pointer.clientX <= rect.right
        const withinVerticalBounds = pointer.clientY >= rect.top + rect.height * DROP_EDGE_RATIO
            && pointer.clientY <= rect.bottom - rect.height * DROP_EDGE_RATIO
        if (withinHorizontalBounds && withinVerticalBounds) {
            return { kind: targetKind === 'character' ? 'merge' : 'folder', id: targetId }
        }
    }

    return null
}

function uniqueCharacterIds(ids: string[], seen: Set<string>) {
    return ids.filter((id) => {
        if (!id || seen.has(id)) return false
        seen.add(id)
        return true
    })
}

export function readSidebarOrderFromDom(root: HTMLElement, currentOrder: SidebarOrder): SidebarOrder {
    const existingFolders = new Map(
        currentOrder
            .filter((item): item is folder => typeof item !== 'string')
            .map((item) => [item.id, item]),
    )
    const nextOrder: SidebarOrder = []
    const seenCharacterIds = new Set<string>()

    for (const element of directSortableItems(root)) {
        const key = element.dataset.sidebarOrderKey
        if (!key) continue
        const existingFolder = existingFolders.get(key)
        if (!existingFolder) {
            if (!seenCharacterIds.has(key)) {
                seenCharacterIds.add(key)
                nextOrder.push(key)
            }
            continue
        }

        const folderContainer = Array.from(element.querySelectorAll<HTMLElement>(LIST_SELECTOR))
            .find((list) => list.dataset.sortableContainerKey === key)
        const folderIds = folderContainer
            ? directSortableItems(folderContainer).map((child) => child.dataset.sidebarOrderKey ?? '')
            : existingFolder.data
        nextOrder.push({
            ...existingFolder,
            data: uniqueCharacterIds(folderIds, seenCharacterIds),
        })
    }

    return nextOrder
}

function cloneSidebarOrder(order: SidebarOrder): SidebarOrder {
    return order.map((item) => typeof item === 'string' ? item : { ...item, data: [...item.data] })
}

function removeCharacter(order: SidebarOrder, sourceId: string) {
    const rootIndex = order.indexOf(sourceId)
    if (rootIndex >= 0) {
        order.splice(rootIndex, 1)
        return true
    }
    for (const item of order) {
        if (typeof item === 'string') continue
        const childIndex = item.data.indexOf(sourceId)
        if (childIndex < 0) continue
        item.data.splice(childIndex, 1)
        return true
    }
    return false
}

export function applySidebarDrop(
    currentOrder: SidebarOrder,
    sourceId: string,
    target: SidebarDropTarget | null,
    createFolder: () => Pick<folder, 'id' | 'name' | 'color'>,
): SidebarOrder | null {
    if (!target || !sourceId || sourceId === target.id) return null

    if (target.kind === 'merge') {
        const targetIsRootCharacter = currentOrder.includes(target.id)
        const sourceExists = currentOrder.includes(sourceId)
            || currentOrder.some((item) => typeof item !== 'string' && item.data.includes(sourceId))
        if (!targetIsRootCharacter || !sourceExists) return null

        const nextOrder = cloneSidebarOrder(currentOrder)
        removeCharacter(nextOrder, sourceId)
        const targetIndex = nextOrder.indexOf(target.id)
        if (targetIndex < 0) return null
        nextOrder[targetIndex] = {
            ...createFolder(),
            data: [sourceId, target.id],
        }
        return nextOrder
    }

    const targetExists = currentOrder.some((item) => typeof item !== 'string' && item.id === target.id)
    if (!targetExists) return null
    const nextOrder = cloneSidebarOrder(currentOrder)
    if (!removeCharacter(nextOrder, sourceId)) return null
    const targetFolder = nextOrder.find((item): item is folder =>
        typeof item !== 'string' && item.id === target.id)
    if (!targetFolder) return null
    targetFolder.data.push(sourceId)
    return nextOrder
}

interface SidebarDragControllerOptions {
    root: () => HTMLElement | undefined
    onTargetChange: (target: SidebarDropTarget | null) => void
}

export function createSidebarDragController({ root, onTargetChange }: SidebarDragControllerOptions) {
    let sourceId: string | null = null
    let sourceCanDrop = false
    let target: SidebarDropTarget | null = null
    let draggedElement: HTMLElement | undefined
    let renderedSize: number | null = null
    let targetSize: number | null = null
    let dragSizeFrame = 0
    let reorderRects = new Map<HTMLElement, ElementPosition>()
    let reorderElements = new Map<HTMLElement, RelativeStyle>()
    let reorderFrame = 0
    let trackingPointerEvent = false

    function setTarget(nextTarget: SidebarDropTarget | null) {
        if (target?.kind === nextTarget?.kind && target?.id === nextTarget?.id) return
        target = nextTarget
        onTargetChange(target)
    }

    function updateTarget(pointer: PointerPosition | null) {
        setTarget(sourceCanDrop && pointer
            ? findSidebarDropTarget(root(), sourceId, pointer.clientX, pointer.clientY)
            : null)
    }

    function dragElements(item?: HTMLElement) {
        return [...new Set([
            item,
            draggedElement,
            Sortable.dragged ?? undefined,
            Sortable.ghost ?? undefined,
        ].filter((element): element is HTMLElement => Boolean(element)))]
    }

    function writeDragSize(size: number, item?: HTMLElement) {
        const value = `${size}px`
        for (const element of dragElements(item)) element.style.setProperty(DRAG_SIZE_PROPERTY, value)
        renderedSize = size
    }

    function updateDragSize(size: number, item?: HTMLElement, immediate = false) {
        if (item) draggedElement = item
        if (targetSize === size && !immediate) {
            if (renderedSize !== null) writeDragSize(renderedSize, item)
            return
        }

        if (dragSizeFrame) cancelAnimationFrame(dragSizeFrame)
        dragSizeFrame = 0
        const startSize = renderedSize ?? size
        targetSize = size
        if (immediate || Math.abs(startSize - size) < POSITION_EPSILON) {
            writeDragSize(size, item)
            return
        }

        const startedAt = performance.now()
        const animate = (now: number) => {
            const progress = Math.min(1, (now - startedAt) / DRAG_SIZE_DURATION)
            const eased = 1 - Math.pow(1 - progress, 3)
            const interpolated = startSize + (size - startSize) * eased
            const nextSize = progress === 1
                ? size
                : snapCssLengthToPhysicalPixel(interpolated, globalThis.devicePixelRatio)
            writeDragSize(nextSize, item)
            if (progress < 1 && targetSize === size) dragSizeFrame = requestAnimationFrame(animate)
            else dragSizeFrame = 0
        }
        dragSizeFrame = requestAnimationFrame(animate)
    }

    function clearDragSize(item?: HTMLElement) {
        if (dragSizeFrame) cancelAnimationFrame(dragSizeFrame)
        dragSizeFrame = 0
        for (const element of dragElements(item)) element.style.removeProperty(DRAG_SIZE_PROPERTY)
        draggedElement = undefined
        renderedSize = null
        targetSize = null
    }

    function restoreRelativeStyle(element: HTMLElement, style: RelativeStyle) {
        for (const [property, value] of Object.entries(style)) {
            if (value) element.style.setProperty(property, value)
            else element.style.removeProperty(property)
        }
    }

    function clearReorderAnimation() {
        if (reorderFrame) cancelAnimationFrame(reorderFrame)
        reorderFrame = 0
        for (const [element, style] of reorderElements) restoreRelativeStyle(element, style)
        reorderElements.clear()
        reorderRects.clear()
    }

    function captureReorderRects(from: HTMLElement, to: HTMLElement) {
        const elements = [...new Set([...directSortableItems(from), ...directSortableItems(to)])]
        const visualRects = new Map(elements.map((element) => {
            const rect = element.getBoundingClientRect()
            return [element, { left: rect.left, top: rect.top }] as const
        }))
        clearReorderAnimation()
        reorderRects = visualRects
    }

    function animateReorder() {
        if (!reorderRects.size) return
        const devicePixelRatio = globalThis.devicePixelRatio
        const movements = Array.from(reorderRects).flatMap(([element, previous]) => {
            if (!element.isConnected || element === Sortable.dragged) return []
            const current = element.getBoundingClientRect()
            const x = snapCssLengthToPhysicalPixel(previous.left - current.left, devicePixelRatio)
            const y = snapCssLengthToPhysicalPixel(previous.top - current.top, devicePixelRatio)
            return Math.abs(x) < POSITION_EPSILON && Math.abs(y) < POSITION_EPSILON
                ? []
                : [{ element, x, y }]
        })
        reorderRects.clear()
        if (!movements.length) return

        for (const { element, x, y } of movements) {
            reorderElements.set(element, {
                position: element.style.getPropertyValue('position'),
                left: element.style.getPropertyValue('left'),
                top: element.style.getPropertyValue('top'),
            })
            // Relative offsets retain FLIP movement without creating a transform
            // layer, whose raster bounds make one-pixel borders pulse at zoom.
            element.style.setProperty('position', 'relative')
            element.style.setProperty('left', `${x}px`)
            element.style.setProperty('top', `${y}px`)
        }

        const startedAt = performance.now()
        const animate = (now: number) => {
            const progress = Math.min(1, (now - startedAt) / REORDER_DURATION)
            const remaining = Math.pow(1 - progress, 3)
            for (const { element, x, y } of movements) {
                const originalStyle = reorderElements.get(element)
                if (!originalStyle) continue
                if (!element.isConnected || progress === 1) {
                    restoreRelativeStyle(element, originalStyle)
                    reorderElements.delete(element)
                    continue
                }
                const renderedX = snapCssLengthToPhysicalPixel(x * remaining, devicePixelRatio)
                const renderedY = snapCssLengthToPhysicalPixel(y * remaining, devicePixelRatio)
                element.style.setProperty('left', `${renderedX}px`)
                element.style.setProperty('top', `${renderedY}px`)
            }
            if (progress < 1) reorderFrame = requestAnimationFrame(animate)
            else reorderFrame = 0
        }
        reorderFrame = requestAnimationFrame(animate)
    }

    function updateDragSizeFromContainer() {
        const rootElement = root()
        const list = Sortable.dragged?.parentElement?.closest<HTMLElement>(LIST_SELECTOR)
        if (!list || !rootElement || (list !== rootElement && !rootElement.contains(list))) return
        updateDragSize(list === rootElement ? SIDEBAR_ROOT_ITEM_SIZE : SIDEBAR_FOLDER_ITEM_SIZE)
    }

    function trackPointer(pointer: PointerPosition | null) {
        updateTarget(pointer)
        if (target?.kind === 'folder') updateDragSize(SIDEBAR_FOLDER_ITEM_SIZE)
        else if (target?.kind === 'merge') updateDragSize(SIDEBAR_ROOT_ITEM_SIZE)
        else updateDragSizeFromContainer()
    }

    function trackEvent(event: Event) {
        trackPointer(eventPointer(event))
    }

    function startTracking() {
        stopTracking()
        if (typeof document === 'undefined') return
        trackingPointerEvent = typeof PointerEvent !== 'undefined'
        document.addEventListener('dragover', trackEvent, true)
        document.addEventListener(trackingPointerEvent ? 'pointermove' : 'mousemove', trackEvent, true)
        document.addEventListener('touchmove', trackEvent, { capture: true, passive: true })
    }

    function stopTracking() {
        if (typeof document === 'undefined') return
        document.removeEventListener('dragover', trackEvent, true)
        document.removeEventListener(trackingPointerEvent ? 'pointermove' : 'mousemove', trackEvent, true)
        document.removeEventListener('touchmove', trackEvent, true)
    }

    function move(event: MoveEvent, originalEvent: Event) {
        const rootElement = root()
        const dragged = event.dragged as HTMLElement
        if (dragged.dataset.sidebarKind === 'folder' && event.to !== rootElement) return false
        trackPointer(eventPointer(originalEvent))
        if (target) {
            reorderRects.clear()
            return false
        }
        captureReorderRects(event.from, event.to)
        return true
    }

    function change(event: SortableEvent) {
        updateDragSize(event.to === root() ? SIDEBAR_ROOT_ITEM_SIZE : SIDEBAR_FOLDER_ITEM_SIZE)
        animateReorder()
    }

    const sortableOptions = {
        direction: 'vertical',
        animation: 0,
        invertSwap: true,
        swapThreshold: INVERTED_SWAP_THRESHOLD,
        invertedSwapThreshold: INVERTED_SWAP_THRESHOLD,
        forceFallback: true,
        fallbackOnBody: true,
        fallbackTolerance: 3,
        fallbackClass: FALLBACK_CLASS,
        onMove: move,
        onChange: change,
    } satisfies Partial<Options>

    return {
        sortableOptions,
        start(draggedId: string, event: SortableEvent) {
            sourceId = draggedId || null
            draggedElement = event.item
            sourceCanDrop = event.item.dataset.sidebarKind === 'character'
            setTarget(null)
            updateDragSize(event.from === root() ? SIDEBAR_ROOT_ITEM_SIZE : SIDEBAR_FOLDER_ITEM_SIZE, event.item, true)
            startTracking()
        },
        shouldSyncOrder(event?: SortableEvent) {
            const pointer = eventPointer((event as SortableEventWithPointer | undefined)?.originalEvent)
            if (pointer) updateTarget(pointer)
            return target === null
        },
        end(event: SortableEvent) {
            const pointer = eventPointer((event as SortableEventWithPointer).originalEvent)
            if (pointer) updateTarget(pointer)
            const completedTarget = target
            reorderRects.clear()
            stopTracking()
            clearDragSize(event.item)
            sourceId = null
            sourceCanDrop = false
            setTarget(null)
            return completedTarget
        },
        destroy() {
            stopTracking()
            clearDragSize()
            clearReorderAnimation()
            sourceId = null
            sourceCanDrop = false
            setTarget(null)
        },
    }
}

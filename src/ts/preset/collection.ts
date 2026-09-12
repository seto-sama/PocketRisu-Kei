import { safeStructuredClone } from '../polyfill'
import { createEntityId } from '../id'

export interface PresetCollectionResult<T> {
    items: T[]
    selectedIndex: number
    changed: boolean
}

export interface PresetCollectionInsertResult<T> extends PresetCollectionResult<T> {
    item?: T
}

function presetIdentity<T>(item: T): unknown {
    if (item && typeof item === 'object' && 'id' in item) {
        const id = (item as { id?: unknown }).id
        if (typeof id === 'string' && id) return id
    }
    return item
}

function presetId<T>(item: T): string | undefined {
    const identity = presetIdentity(item)
    return typeof identity === 'string' ? identity : undefined
}

export function clonePresetWithNewId<T extends object>(source: T): T & { id: string } {
    return { ...safeStructuredClone(source), id: createEntityId() }
}

export function ensurePresetIds<T extends { id?: string }>(
    items: T[],
    createId: () => string = createEntityId,
): void {
    for (const item of items) {
        if (!item.id) item.id = createId()
    }
}

export function appendPresetItem<T>(items: T[], item: T): PresetCollectionInsertResult<T> {
    const next = [...items, item]
    return {
        items: next,
        selectedIndex: next.length - 1,
        changed: true,
        item,
    }
}

export function duplicatePresetItem<T>(
    items: T[],
    index: number,
    createCopy: (source: T) => T,
    insertIndex = items.length,
): PresetCollectionInsertResult<T> {
    const source = items[index]
    if (!source) return { items, selectedIndex: -1, changed: false }
    const item = createCopy(source)
    const boundedIndex = Math.min(Math.max(insertIndex, 0), items.length)
    const next = [...items]
    next.splice(boundedIndex, 0, item)
    return { items: next, selectedIndex: boundedIndex, changed: true, item }
}

export function removePresetItem<T>(
    items: T[],
    selectedIndex: number,
    index: number,
    minimumItems = 1,
): PresetCollectionResult<T> {
    if (items.length <= minimumItems || !items[index]) {
        return { items, selectedIndex, changed: false }
    }

    const selectedIdentity = presetIdentity(items[selectedIndex])
    const next = items.filter((_, itemIndex) => itemIndex !== index)
    const preservedIndex = next.findIndex(item => presetIdentity(item) === selectedIdentity)
    return {
        items: next,
        selectedIndex: preservedIndex >= 0 ? preservedIndex : Math.min(index, next.length - 1),
        changed: true,
    }
}

export function movePresetItem<T>(
    items: T[],
    selectedIndex: number,
    fromIndex: number,
    toIndex: number,
): PresetCollectionResult<T> {
    if (
        fromIndex === toIndex
        || fromIndex < 0
        || toIndex < 0
        || fromIndex >= items.length
        || toIndex > items.length
    ) {
        return { items, selectedIndex, changed: false }
    }

    const selectedIdentity = presetIdentity(items[selectedIndex])
    const next = [...items]
    const [moved] = next.splice(fromIndex, 1)
    if (!moved) return { items, selectedIndex, changed: false }
    next.splice(fromIndex < toIndex ? toIndex - 1 : toIndex, 0, moved)

    return {
        items: next,
        selectedIndex: Math.max(0, next.findIndex(item => presetIdentity(item) === selectedIdentity)),
        changed: true,
    }
}

/** Reorders the matching ID-backed items in place while preserving all other slots. */
export function reorderPresetSubset<T>(
    items: T[],
    selectedIndex: number,
    orderedIds: string[],
): PresetCollectionResult<T> {
    if (new Set(orderedIds).size !== orderedIds.length) {
        return { items, selectedIndex, changed: false }
    }

    const byId = new Map(items.map(item => [presetId(item), item]))
    const reordered = orderedIds.map(id => byId.get(id)).filter((item): item is T => !!item)
    if (reordered.length !== orderedIds.length) {
        return { items, selectedIndex, changed: false }
    }

    const targetIds = new Set(orderedIds)
    const selectedIdentity = presetIdentity(items[selectedIndex])
    let reorderedIndex = 0
    const next = items.map(item => {
        const id = presetId(item)
        return id && targetIds.has(id) ? reordered[reorderedIndex++] : item
    })

    return {
        items: next,
        selectedIndex: Math.max(0, next.findIndex(item => presetIdentity(item) === selectedIdentity)),
        changed: next.some((item, index) => item !== items[index]),
    }
}

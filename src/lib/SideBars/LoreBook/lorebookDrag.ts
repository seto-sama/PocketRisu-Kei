import type { loreBook } from 'src/ts/storage/database.svelte'

/** Read Sortable's final row placement using item identity, not pre-drag offsets. */
export function reorderLoreBooks(target: HTMLElement, dragged: HTMLElement, current: loreBook[]): loreBook[] | null {
    const itemForRow = (row: HTMLElement) => current[Number.parseInt(row.dataset.risuIdx ?? '', 10)]
    const moved = itemForRow(dragged)
    const targetFolder = target.dataset.showFolder || ''
    // Lorebook folders contain entries, not other folders.
    if (!moved || (moved.mode === 'folder' && targetFolder)) return null

    const block = current.filter(item => item === moved || (moved.mode === 'folder' && item.folder === moved.key))
    const moving = new Set(block)
    const remaining = current.filter(item => !moving.has(item))
    const remainingItems = new Set(remaining)
    const rows = Array.from(target.children).filter((child): child is HTMLElement =>
        child instanceof HTMLElement && child.matches('[data-risu-idx]:not([data-risu-hidden]):not(.sortable-fallback)'))
    const position = rows.indexOf(dragged)
    if (position === -1) return null

    const next = rows.slice(position + 1).map(itemForRow).find(item => remainingItems.has(item))
    const previous = rows.slice(0, position).reverse().map(itemForRow).find(item => remainingItems.has(item))
    let insertIndex: number
    if (next) {
        insertIndex = remaining.indexOf(next)
    } else if (previous) {
        // A root row after a folder belongs after that folder's children as well.
        insertIndex = remaining.findLastIndex(item => item === previous ||
            (previous.mode === 'folder' && item.folder === previous.key)) + 1
    } else if (targetFolder) {
        const parentIndex = remaining.findIndex(item => item.mode === 'folder' && item.key === targetFolder)
        if (parentIndex === -1) return null
        insertIndex = parentIndex + 1
    } else {
        insertIndex = remaining.length
    }

    if (targetFolder) moved.folder = targetFolder
    else delete moved.folder
    remaining.splice(insertIndex, 0, moved, ...block.filter(item => item !== moved))
    return remaining
}

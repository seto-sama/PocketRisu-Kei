import { describe, expect, it } from 'vitest'
import type { loreBook } from 'src/ts/storage/database.svelte'
import { reorderLoreBooks } from './lorebookDrag'

function book(key: string, mode: loreBook['mode'] = 'normal', folder?: string): loreBook {
    return { key, mode, folder, comment: key, content: '', insertorder: 100, alwaysActive: false, secondkey: '', selective: false }
}

function drop(current: loreBook[], moved: loreBook, visible: loreBook[], folder = '') {
    const target = document.createElement('div')
    target.dataset.showFolder = folder
    let dragged: HTMLElement
    for (const item of visible) {
        const row = document.createElement('div')
        row.dataset.risuIdx = String(current.indexOf(item))
        target.appendChild(row)
        if (item === moved) dragged = row
    }
    for (const [index, item] of current.entries()) {
        if (visible.includes(item)) continue
        const marker = document.createElement('div')
        marker.dataset.risuIdx = String(index)
        marker.dataset.risuHidden = 'true'
        target.appendChild(marker)
    }
    if (folder && !current.some(item => item.folder === folder)) {
        target.prepend(document.createElement('div'))
    }
    return reorderLoreBooks(target, dragged!, current)
}

describe('reorderLoreBooks', () => {
    it('moves a folder down one row with its children, preserving object identity', () => {
        const a = book('A', 'folder'), child = book('child', 'normal', 'A')
        const b = book('B', 'folder'), c = book('C', 'folder')
        const current = [a, child, b, c]
        const result = drop(current, a, [b, a, c])!
        expect(result).toEqual([b, a, child, c])
        expect(result[1]).toBe(a)
        expect(result[2]).toBe(child)
        expect(current).toEqual([a, child, b, c])
    })

    it('moves a folder upward and to the end after the preceding folder children', () => {
        const a = book('A', 'folder'), ac = book('ac', 'normal', 'A')
        const b = book('B', 'folder'), bc = book('bc', 'normal', 'B')
        expect(drop([a, ac, b, bc], b, [b, a])).toEqual([b, bc, a, ac])
        expect(drop([a, ac, b, bc], a, [b, a])).toEqual([b, bc, a, ac])
    })

    it('reorders entries within a folder in both directions', () => {
        const f = book('F', 'folder')
        const a = book('A', 'normal', 'F'), b = book('B', 'normal', 'F'), c = book('C', 'normal', 'F')
        expect(drop([f, a, b, c], a, [b, a, c], 'F')).toEqual([f, b, a, c])
        expect(drop([f, a, b, c], c, [c, a, b], 'F')).toEqual([f, c, a, b])
    })

    it('moves an entry into an empty folder and back to the root', () => {
        const f = book('F', 'folder'), entry = book('entry'), tail = book('tail')
        const result = drop([entry, f, tail], entry, [entry], 'F')!
        expect(result).toEqual([f, entry, tail])
        expect(entry.folder).toBe('F')
        expect(drop(result, entry, [f, entry, tail])).toEqual([f, entry, tail])
        expect(entry.folder).toBeUndefined()
    })

    it('moves an entry between populated folders', () => {
        const a = book('A', 'folder'), x = book('x', 'normal', 'A')
        const b = book('B', 'folder'), y = book('y', 'normal', 'B')
        expect(drop([a, x, b, y], x, [y, x], 'B')).toEqual([a, b, y, x])
        expect(x.folder).toBe('B')
    })
})

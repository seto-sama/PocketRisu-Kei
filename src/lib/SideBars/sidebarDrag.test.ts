// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { folder } from 'src/ts/storage/database.svelte'
import {
    applySidebarDrop,
    findSidebarDropTarget,
    readSidebarOrderFromDom,
    type SidebarOrder,
} from './sidebarDrag'

function addItem(container: HTMLElement, id: string, kind: 'character' | 'folder', top = 0) {
    const item = document.createElement('div')
    item.dataset.sidebarOrderKey = id
    item.dataset.sidebarKind = kind
    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    const rect = () => ({
        left: 10,
        right: 66,
        top,
        bottom: top + 56,
        width: 56,
        height: 56,
        x: 10,
        y: top,
        toJSON: () => ({}),
    })
    avatar.getBoundingClientRect = rect
    item.getBoundingClientRect = rect
    item.appendChild(avatar)
    container.appendChild(item)
    return item
}

function folderItem(id: string, data: string[]): folder {
    return { id, data, name: id, color: '' }
}

const newFolder = () => ({ id: 'new-folder', name: 'Folder', color: '' })

describe('findSidebarDropTarget', () => {
    it('finds character merges and folder appends through the same target pipeline', () => {
        const container = document.createElement('div')
        addItem(container, 'source', 'character', 0)
        addItem(container, 'character', 'character', 80)
        addItem(container, 'folder', 'folder', 160)

        expect(findSidebarDropTarget(container, 'source', 38, 108))
            .toEqual({ kind: 'merge', id: 'character' })
        expect(findSidebarDropTarget(container, 'source', 38, 188))
            .toEqual({ kind: 'folder', id: 'folder' })
    })

    it('leaves avatar edges and invalid pointer coordinates to Sortable', () => {
        const container = document.createElement('div')
        addItem(container, 'source', 'character', 0)
        addItem(container, 'target', 'character', 80)

        expect(findSidebarDropTarget(container, 'source', 38, 82)).toBeNull()
        expect(findSidebarDropTarget(container, 'source', 38, 134)).toBeNull()
        expect(findSidebarDropTarget(container, 'source', Number.NaN, 108)).toBeNull()
        expect(findSidebarDropTarget(container, null, 38, 108)).toBeNull()
    })

    it('never targets the dragged item itself', () => {
        const container = document.createElement('div')
        addItem(container, 'source', 'character')

        expect(findSidebarDropTarget(container, 'source', 38, 28)).toBeNull()
    })
})

describe('applySidebarDrop', () => {
    it('creates a folder without mutating the current order', () => {
        const current: SidebarOrder = ['source', 'target', folderItem('existing', ['inside'])]
        const next = applySidebarDrop(current, 'source', { kind: 'merge', id: 'target' }, newFolder)

        expect(next).toEqual([
            { id: 'new-folder', name: 'Folder', color: '', data: ['source', 'target'] },
            folderItem('existing', ['inside']),
        ])
        expect(current).toEqual(['source', 'target', folderItem('existing', ['inside'])])
    })

    it('can merge a character out of an existing folder', () => {
        const current: SidebarOrder = [folderItem('source-folder', ['source', 'sibling']), 'target']
        const next = applySidebarDrop(current, 'source', { kind: 'merge', id: 'target' }, newFolder)

        expect(next).toEqual([
            folderItem('source-folder', ['sibling']),
            { id: 'new-folder', name: 'Folder', color: '', data: ['source', 'target'] },
        ])
    })

    it('appends to a folder and moves an existing child to its bottom', () => {
        const current: SidebarOrder = [folderItem('folder', ['source', 'sibling'])]
        const next = applySidebarDrop(current, 'source', { kind: 'folder', id: 'folder' }, newFolder)

        expect(next).toEqual([folderItem('folder', ['sibling', 'source'])])
        expect(current).toEqual([folderItem('folder', ['source', 'sibling'])])
    })

    it('leaves the order untouched when either side of the drop is stale', () => {
        const current: SidebarOrder = ['source', folderItem('folder', [])]

        expect(applySidebarDrop(current, 'source', { kind: 'folder', id: 'missing' }, newFolder)).toBeNull()
        expect(applySidebarDrop(current, 'missing', { kind: 'folder', id: 'folder' }, newFolder)).toBeNull()
        expect(current).toEqual(['source', folderItem('folder', [])])
    })
})

describe('readSidebarOrderFromDom', () => {
    it('reads root and open-folder order while preserving folder metadata', () => {
        const root = document.createElement('div')
        const folderElement = addItem(root, 'folder', 'folder')
        addItem(root, 'root-character', 'character')
        const folderList = document.createElement('div')
        folderList.dataset.risuSortableList = ''
        folderList.dataset.sortableContainerKey = 'folder'
        addItem(folderList, 'second', 'character')
        addItem(folderList, 'first', 'character')
        folderElement.appendChild(folderList)

        const current: SidebarOrder = [
            'root-character',
            { ...folderItem('folder', ['first', 'second']), localOnly: true },
        ]
        expect(readSidebarOrderFromDom(root, current)).toEqual([
            { ...folderItem('folder', ['second', 'first']), localOnly: true },
            'root-character',
        ])
        expect(current[1]).toEqual({ ...folderItem('folder', ['first', 'second']), localOnly: true })
    })
})

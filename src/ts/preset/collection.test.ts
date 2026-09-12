import { describe, expect, it } from 'vitest'
import {
    appendPresetItem,
    clonePresetWithNewId,
    duplicatePresetItem,
    ensurePresetIds,
    movePresetItem,
    reorderPresetSubset,
    removePresetItem,
} from './collection'

const item = (id: string) => ({ id, name: id })

describe('preset collection', () => {
    it('deep-clones presets while issuing a fresh stable id', () => {
        const source = { id: 'source', name: 'Source', settings: { value: 1 } }

        const copy = clonePresetWithNewId(source)

        expect(copy.id).not.toBe(source.id)
        expect(copy.settings).toEqual(source.settings)
        expect(copy.settings).not.toBe(source.settings)
    })

    it('migrates missing stable ids without replacing existing ids', () => {
        const items = [{ name: 'legacy' }, { id: 'existing', name: 'current' }]
        let nextId = 0

        ensurePresetIds(items, () => `generated-${++nextId}`)

        expect(items).toEqual([
            { id: 'generated-1', name: 'legacy' },
            { id: 'existing', name: 'current' },
        ])
    })

    it('selects appended and duplicated items', () => {
        const first = item('first')
        const appended = appendPresetItem([first], item('second'))
        const duplicated = duplicatePresetItem(
            appended.items,
            0,
            source => ({ ...source, id: 'copy', name: `${source.name} Copy` }),
        )

        expect(appended.selectedIndex).toBe(1)
        expect(duplicated.items.map(entry => entry.id)).toEqual(['first', 'second', 'copy'])
        expect(duplicated.selectedIndex).toBe(2)
        expect(duplicated.item?.name).toBe('first Copy')
    })

    it('keeps the selected stable id while moving and removing siblings', () => {
        const items = [item('first'), item('selected'), item('third')]
        const moved = movePresetItem(items, 1, 1, 3)
        const removed = removePresetItem(moved.items, moved.selectedIndex, 0)

        expect(moved.items[moved.selectedIndex].id).toBe('selected')
        expect(removed.items[removed.selectedIndex].id).toBe('selected')
    })

    it('selects a neighboring item when removing the active item', () => {
        const result = removePresetItem([item('first'), item('second'), item('third')], 1, 1)

        expect(result.items.map(entry => entry.id)).toEqual(['first', 'third'])
        expect(result.selectedIndex).toBe(1)
    })

    it('rejects invalid changes and never removes the final item', () => {
        const items = [item('only')]

        expect(removePresetItem(items, 0, 0)).toMatchObject({ items, selectedIndex: 0, changed: false })
        expect(movePresetItem(items, 0, -1, 0)).toMatchObject({ items, selectedIndex: 0, changed: false })
        expect(duplicatePresetItem(items, 2, source => source)).toMatchObject({
            items,
            selectedIndex: -1,
            changed: false,
        })
    })

    it('reorders an ID-backed subset without moving unrelated items', () => {
        const items = [item('first'), item('fixed'), item('second'), item('third')]
        const result = reorderPresetSubset(items, 2, ['third', 'second', 'first'])

        expect(result.items.map(entry => entry.id)).toEqual(['third', 'fixed', 'second', 'first'])
        expect(result.items[result.selectedIndex].id).toBe('second')
    })
})

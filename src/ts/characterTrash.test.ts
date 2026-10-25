import { describe, expect, it } from 'vitest'
import { moveToTrash, restoreFromTrash } from './characterTrash'
import type { character, folder } from './storage/database.svelte'

const char = (chaId: string) => ({ chaId }) as character
const folderEntry = (data: string[]): folder =>
    ({ id: 'F', name: 'Folder', color: 'red', localOnly: true, imgFile: 'assets/f.png', data })

describe('character trash folders', () => {
    it('recreates a folder that was dropped while empty', () => {
        const order: (string | folder)[] = ['top', folderEntry(['c1'])]
        const c1 = char('c1')
        moveToTrash(order, c1)
        expect(c1.trashFolder).toEqual({ id: 'F', name: 'Folder', color: 'red', localOnly: true, imgFile: 'assets/f.png' })

        order.splice(1, 1) // checkCharOrder drops the now-empty folder
        restoreFromTrash(order, c1)

        expect(order).toEqual(['top', folderEntry(['c1'])])
        expect(c1.trashTime).toBeUndefined()
        expect(c1.trashFolder).toBeUndefined()
    })

    it('rejoins a folder that still exists and leaves unfoldered characters alone', () => {
        const order: (string | folder)[] = ['top', folderEntry(['c1', 'c2'])]
        const c1 = char('c1')
        const top = char('top')
        moveToTrash(order, c1)
        moveToTrash(order, top)
        expect(top.trashFolder).toBeUndefined()
        ;(order[1] as folder).data = ['c2']

        restoreFromTrash(order, c1)
        restoreFromTrash(order, top)

        expect(order).toEqual(['top', folderEntry(['c2', 'c1'])])
    })
})

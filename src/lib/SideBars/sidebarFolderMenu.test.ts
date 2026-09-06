import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { folder, Database } from 'src/ts/storage/database.svelte'

const mocks = vi.hoisted(() => ({
    DBState: { db: { characterOrder: [] as Array<string | folder> } },
    file: vi.fn(), save: vi.fn(),
}))
vi.mock(import('src/ts/stores.svelte'), () => ({ DBState: mocks.DBState as { db: Database } }))
vi.mock(import('src/ts/util'), () => ({ selectSingleFile: mocks.file }))
vi.mock(import('src/ts/globalApi.svelte'), () => ({ saveAsset: mocks.save }))

import { folderSettingsTarget, openSidebarFolderMenu, updateSidebarFolder, pickSidebarFolderImage } from './sidebarFolderMenu'
import { folderDisplayMode } from './folderDisplay'
const makeFolder = (id: string): folder => ({ id, name: id, color: 'default', data: [] })

describe('sidebar folder settings', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        folderSettingsTarget.set(null)
        mocks.DBState.db = { characterOrder: [makeFolder('a'), makeFolder('b')] }
    })

    it('opens an existing folder and patches it by ID after a reorder', () => {
        openSidebarFolderMenu('missing')
        expect(get(folderSettingsTarget)).toBeNull()
        openSidebarFolderMenu('a')
        expect(get(folderSettingsTarget)).toBe('a')
        mocks.DBState.db.characterOrder.reverse()
        updateSidebarFolder('a', { name: 'renamed', nodeOnlyDisplay: 'name' })
        expect(mocks.DBState.db.characterOrder).toEqual([
            makeFolder('b'), { ...makeFolder('a'), name: 'renamed', nodeOnlyDisplay: 'name' },
        ])
    })

    it('patches the original target after projection replacement and switching dialogs during upload', async () => {
        mocks.file.mockResolvedValue({ data: new Uint8Array([1]) })
        mocks.save.mockImplementation(async () => {
            mocks.DBState.db = { characterOrder: [makeFolder('b'), {
                ...makeFolder('a'), name: 'remote name', color: 'red', data: ['new-member'],
            }] }
            openSidebarFolderMenu('b')
            return 'assets/new.png'
        })
        await pickSidebarFolderImage('a')
        expect(mocks.DBState.db.characterOrder[0]).toEqual(makeFolder('b'))
        expect(mocks.DBState.db.characterOrder[1]).toEqual({
            ...makeFolder('a'), name: 'remote name', color: 'red', data: ['new-member'],
            imgFile: 'assets/new.png', img: '',
        })
    })

    it('does not recreate a folder deleted during the picker or upload', async () => {
        mocks.file.mockImplementation(async () => {
            mocks.DBState.db.characterOrder.shift()
            return { data: new Uint8Array([1]) }
        })
        await pickSidebarFolderImage('a')
        expect(mocks.save).not.toHaveBeenCalled()
        mocks.DBState.db.characterOrder.unshift(makeFolder('a'))
        mocks.file.mockResolvedValue({ data: new Uint8Array([1]) })
        mocks.save.mockImplementation(async () => {
            mocks.DBState.db.characterOrder.shift()
            return 'assets/new.png'
        })
        await pickSidebarFolderImage('a')
        expect(mocks.DBState.db.characterOrder).toEqual([makeFolder('b')])
    })

    it('preserves legacy display precedence until a folder explicitly chooses its mode', () => {
        const target = makeFolder('a')
        expect(folderDisplayMode(target, false)).toBe('icon')
        expect(folderDisplayMode(target, true)).toBe('name')
        target.imgFile = 'assets/old.png'
        expect(folderDisplayMode(target, true)).toBe('image')
        target.nodeOnlyDisplay = 'name'
        expect(folderDisplayMode(target, false)).toBe('name')
    })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { folder } from 'src/ts/storage/database.svelte'

const mocks = vi.hoisted(() => ({
    DBState: { db: { characterOrder: [] as Array<string | folder> } },
    select: vi.fn(), input: vi.fn(), file: vi.fn(), save: vi.fn(), src: vi.fn(),
}))
vi.mock(import('src/ts/stores.svelte'), () => ({ DBState: mocks.DBState }))
vi.mock(import('src/ts/alert'), () => ({ alertSelect: mocks.select, alertInput: mocks.input }))
vi.mock(import('src/ts/util'), () => ({ selectSingleFile: mocks.file }))
vi.mock(import('src/ts/globalApi.svelte'), () => ({ saveAsset: mocks.save, getFileSrc: mocks.src }))

import { openSidebarFolderMenu } from './sidebarFolderMenu'
import { folderColorOptions } from './folderColors'

const makeFolder = (id: string): folder => ({ id, name: id, color: 'default', data: [] })

describe('sidebar folder menu target', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        mocks.DBState.db = { characterOrder: [makeFolder('a'), makeFolder('b')] }
    })

    it('renames the original folder after reordering while the input is open', async () => {
        mocks.select.mockResolvedValue('0')
        mocks.input.mockImplementation(async () => {
            mocks.DBState.db.characterOrder.reverse()
            return 'renamed'
        })
        await openSidebarFolderMenu('a')
        expect(mocks.DBState.db.characterOrder).toEqual([
            makeFolder('b'), { ...makeFolder('a'), name: 'renamed' },
        ])
    })

    it('patches the current folder after a projection replacement during an upload', async () => {
        mocks.select.mockResolvedValueOnce('2').mockResolvedValueOnce('1')
        mocks.file.mockResolvedValue({ data: new Uint8Array([1]) })
        mocks.save.mockImplementation(async () => {
            mocks.DBState.db = { characterOrder: [makeFolder('b'), {
                ...makeFolder('a'), name: 'remote name', color: 'red', data: ['new-member'],
            }] }
            return 'assets/new.png'
        })
        mocks.src.mockResolvedValue('/new.png')
        await openSidebarFolderMenu('a')
        expect(mocks.DBState.db.characterOrder[1]).toEqual({
            ...makeFolder('a'), name: 'remote name', color: 'red', data: ['new-member'],
            imgFile: 'assets/new.png', img: '/new.png',
        })
    })

    it('does not recreate a folder deleted during the file dialog or upload', async () => {
        mocks.select.mockResolvedValueOnce('2').mockResolvedValueOnce('1')
        mocks.file.mockImplementation(async () => {
            mocks.DBState.db.characterOrder.shift()
            return { data: new Uint8Array([1]) }
        })
        await openSidebarFolderMenu('a')
        expect(mocks.save).not.toHaveBeenCalled()
        expect(mocks.DBState.db.characterOrder).toEqual([makeFolder('b')])

        mocks.DBState.db.characterOrder.unshift(makeFolder('a'))
        mocks.select.mockResolvedValueOnce('2').mockResolvedValueOnce('1')
        mocks.file.mockResolvedValue({ data: new Uint8Array([1]) })
        mocks.save.mockResolvedValue('assets/new.png')
        mocks.src.mockImplementation(async () => {
            mocks.DBState.db.characterOrder.shift()
            return '/new.png'
        })
        await openSidebarFolderMenu('a')
        expect(mocks.DBState.db.characterOrder).toEqual([makeFolder('b')])
    })

    it('uses the shared color choices and keeps remote visibility changes on the same folder', async () => {
        mocks.select.mockResolvedValueOnce('1').mockImplementationOnce(async () => {
            mocks.DBState.db.characterOrder.reverse()
            return '0'
        })
        await openSidebarFolderMenu('a')
        expect((mocks.DBState.db.characterOrder[1] as folder).color).toBe(folderColorOptions[0].value)

        mocks.select.mockImplementationOnce(async () => {
            mocks.DBState.db.characterOrder.reverse()
            return '3'
        })
        await openSidebarFolderMenu('a')
        expect((mocks.DBState.db.characterOrder[0] as folder).localOnly).toBe(true)
        expect((mocks.DBState.db.characterOrder[1] as folder).localOnly).toBeUndefined()
    })
})

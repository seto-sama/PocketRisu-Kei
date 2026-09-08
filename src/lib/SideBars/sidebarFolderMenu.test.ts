import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { Chat, ChatFolder, folder, Database, character } from 'src/ts/storage/database.svelte'

const mocks = vi.hoisted(() => ({
    DBState: { db: { characterOrder: [] as Array<string | folder>, characters: [] as Database['characters'] } },
    file: vi.fn(), save: vi.fn(),
}))
vi.mock(import('src/ts/stores.svelte'), () => ({ DBState: mocks.DBState as { db: Database } }))
vi.mock(import('src/ts/util'), () => ({ selectSingleFile: mocks.file }))
vi.mock(import('src/ts/globalApi.svelte'), () => ({ saveAsset: mocks.save }))

import {
    chatFolderSettingsTarget,
    deleteChatFolder,
    folderSettingsTarget,
    openChatFolderMenu,
    openSidebarFolderMenu,
    updateChatFolder,
    updateSidebarFolder,
    pickSidebarFolderImage,
} from './sidebarFolderMenu'
import { folderDisplayMode } from './folderDisplay'
const makeFolder = (id: string): folder => ({ id, name: id, color: 'default', data: [] })
const makeChatFolder = (id: string): ChatFolder => ({ id, name: id, folded: false })
const makeChat = (id: string, folderId?: string): Chat => ({ id, message: [], note: '', name: id, localLore: [], folderId })
const makeCharacter = (id: string, chatFolders: ChatFolder[], chats: Chat[]): character => ({ chaId: id, chatFolders, chats } as character)

describe('sidebar folder settings', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        folderSettingsTarget.set(null)
        chatFolderSettingsTarget.set(null)
        mocks.DBState.db = { characterOrder: [makeFolder('a'), makeFolder('b')], characters: [] }
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
            }], characters: [] }
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

    it('updates and deletes chat folders by character and folder ID', () => {
        const folders = [makeChatFolder('f1'), makeChatFolder('f2')]
        const character = makeCharacter('char-a', folders, [
            makeChat('chat-a', 'f1'),
            makeChat('chat-b', 'f1'),
            makeChat('chat-c', 'f2'),
        ])
        mocks.DBState.db.characters = [character]

        openChatFolderMenu('char-a', 'f1')
        expect(get(chatFolderSettingsTarget)).toEqual({ characterId: 'char-a', folderId: 'f1' })
        updateChatFolder('char-a', 'f1', { name: 'renamed', nodeOnlyIcon: 'star' })
        expect(character.chatFolders[0]).toEqual({ ...makeChatFolder('f1'), name: 'renamed', nodeOnlyIcon: 'star' })

        expect(deleteChatFolder('char-a', 'f1')).toBe(true)
        expect(character.chatFolders).toEqual([makeChatFolder('f2')])
        expect(character.chats.map(chat => chat.folderId)).toEqual([undefined, undefined, 'f2'])
        expect(deleteChatFolder('char-a', 'f1')).toBe(false)
    })
})

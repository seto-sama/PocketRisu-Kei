import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    nextId: 0,
    save: vi.fn(),
    mergeTags: vi.fn(),
    finalizeBookmarks: vi.fn(),
}))

vi.mock('./id', () => ({ createEntityId: () => `new-${++mocks.nextId}` }))
vi.mock('./storage/database.svelte', () => ({
    normalizeChat: (chat: Record<string, any>) => {
        chat.message ??= []
        chat.note ??= ''
        chat.name ??= ''
        chat.localLore ??= []
        return chat
    },
}))
vi.mock('./globalApi.svelte', () => ({ requestImmediateSave: mocks.save }))
vi.mock('./bookmarks/bookmarkData', () => ({
    remapBookmarkTags: (chat: any, ids: Record<string, string>) => {
        if (chat.bookmarkTagIds) {
            for (const key of Object.keys(chat.bookmarkTagIds)) {
                chat.bookmarkTagIds[key] = chat.bookmarkTagIds[key].map((id: string) => ids[id]).filter(Boolean)
            }
        }
    },
}))
vi.mock('./bookmarks/bookmarkService', () => ({
    mergeBookmarkTagsForImport: mocks.mergeTags,
    finalizeImportedBookmarks: mocks.finalizeBookmarks,
}))

import { importRisuChats } from './chatImport'

function makeCharacter() {
    return { chaId: 'character-1', chats: [], chatFolders: [] } as any
}

describe('JSON chat import', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.nextId = 0
        mocks.save.mockResolvedValue(undefined)
        mocks.mergeTags.mockResolvedValue({ 'old-tag': 'new-tag' })
        mocks.finalizeBookmarks.mockResolvedValue(undefined)
    })

    it('gives repeated v1 imports fresh IDs and explicitly saves every chat body', async () => {
        const target = makeCharacter()
        const payload = () => ({
            type: 'risuAllChats',
            ver: 1,
            data: [
                { id: 'exported-id', name: 'Saved chat', message: [{ data: 'body' }] },
                { name: 'Unopened chat', message: [] },
            ],
        })

        await importRisuChats(payload(), target)
        await importRisuChats(payload(), target)

        expect(target.chats.map((chat: any) => chat.id)).toEqual(['new-3', 'new-4', 'new-1', 'new-2'])
        expect(target.chats[0].message[0].data).toBe('body')
        expect(mocks.save).toHaveBeenCalledTimes(2)
        expect(mocks.save.mock.calls[0][0].chatTargets).toEqual([
            { characterId: 'character-1', chatId: 'new-1' },
            { characterId: 'character-1', chatId: 'new-2' },
        ])
        expect(mocks.save.mock.calls[1][0].chatTargets).toEqual([
            { characterId: 'character-1', chatId: 'new-3' },
            { characterId: 'character-1', chatId: 'new-4' },
        ])
        expect(mocks.mergeTags).not.toHaveBeenCalled()
        expect(mocks.finalizeBookmarks).not.toHaveBeenCalled()
    })

    it('keeps v2 folder and bookmark handling in the shared import path', async () => {
        const target = makeCharacter()
        target.chatFolders.push({ id: 'folder-1', folded: false })

        await importRisuChats({
            type: 'risuChat',
            ver: 2,
            folders: [{ id: 'folder-1', name: 'Imported', folded: true }],
            bookmarkTags: [{ id: 'old-tag', name: 'Important' }],
            data: {
                name: 'V2 chat',
                message: [],
                folderId: 'folder-1',
                bookmarks: ['message-1'],
                bookmarkTagIds: { 'message-1': ['old-tag'] },
            },
        }, target)

        expect(target.chatFolders[1].id).toBe('new-1')
        expect(target.chats[0]).toMatchObject({
            id: 'new-2',
            folderId: 'new-1',
            bookmarks: ['message-1'],
            bookmarkTagIds: { 'message-1': ['new-tag'] },
        })
        expect(mocks.mergeTags).toHaveBeenCalledWith([{ id: 'old-tag', name: 'Important' }])
        expect(mocks.finalizeBookmarks).toHaveBeenCalledWith(target.chats)
    })
})

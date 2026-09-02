import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    fetchBookmarkCatalog: vi.fn(),
    putBookmark: vi.fn(),
    patchBookmark: vi.fn(),
    deleteBookmark: vi.fn(),
    replaceBookmarkFolders: vi.fn(),
    mergeBookmarkFolders: vi.fn(),
    fetchBookmarkCompatibility: vi.fn(),
}))

vi.mock('../storage/autoStorage', () => ({ forageStorage: { realStorage: mocks } }))
vi.mock('../storage/chatStorage', () => ({ ensureChatHydrated: vi.fn() }))
vi.mock('../chatMessageNavigation', () => ({ navigateToChatMessage: vi.fn() }))
vi.mock('../stores.svelte', () => ({ DBState: { db: { characters: [] } } }))

const service = await import('./bookmarkService')

const catalog = {
    revision: 1,
    folders: [],
    entries: [{
        characterId: 'character-1', chatId: 'room-1', messageId: 'message-1',
        name: 'Saved', preview: 'Body', sortOrder: 0,
    }],
}

describe('server bookmark client', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        service.bookmarkCatalog.set({ revision: 0, folders: [], entries: [] })
        service.bookmarkCatalogLoaded.set(false)
    })

    it('deduplicates an in-flight catalog request', async () => {
        let resolve!: (value: typeof catalog) => void
        mocks.fetchBookmarkCatalog.mockReturnValue(new Promise(r => { resolve = r }))

        const first = service.ensureBookmarkCatalog()
        const second = service.ensureBookmarkCatalog()
        resolve(catalog)

        await expect(first).resolves.toEqual(catalog)
        await expect(second).resolves.toEqual(catalog)
        expect(mocks.fetchBookmarkCatalog).toHaveBeenCalledOnce()
    })

    it('installs the catalog returned by a bookmark mutation', async () => {
        mocks.putBookmark.mockResolvedValue(catalog)
        await service.createBookmark({
            characterId: 'character-1', chatId: 'room-1', messageId: 'message-1',
        }, 'Saved')

        expect(mocks.putBookmark).toHaveBeenCalledWith({
            characterId: 'character-1', chatId: 'room-1', messageId: 'message-1', name: 'Saved',
        })
        expect(get(service.bookmarkKeys)).toContain(
            service.bookmarkKey(catalog.entries[0]),
        )
    })

    it('does not let a stale response overwrite a newer mutation revision', async () => {
        service.bookmarkCatalog.set({ ...catalog, revision: 5 })
        mocks.fetchBookmarkCatalog.mockResolvedValue({ ...catalog, revision: 4, entries: [] })

        await service.refreshBookmarkCatalog()
        expect(get(service.bookmarkCatalog).revision).toBe(5)
        expect(get(service.bookmarkCatalog).entries).toHaveLength(1)
    })

    it('uses one compatibility response to prepare chat export clones', async () => {
        mocks.fetchBookmarkCompatibility.mockResolvedValue({
            entries: [{
                characterId: 'character-1',
                chatId: 'room-1',
                data: {
                    bookmarks: ['message-1'],
                    bookmarkNames: { 'message-1': 'Saved' },
                },
            }],
            folders: [{ id: 'folder-1', name: 'Folder' }],
        })
        const source = {
            id: 'room-1', name: 'Room', note: '', localLore: [],
            message: [{ chatId: 'message-1', role: 'char', data: 'Body' }],
        } as any

        const result = await service.prepareBookmarkCompatibleChats('character-1', [source])

        expect(mocks.fetchBookmarkCompatibility).toHaveBeenCalledWith([
            { characterId: 'character-1', chatId: 'room-1' },
        ])
        expect(result.chats[0].bookmarks).toEqual(['message-1'])
        expect(result.chats[0].bookmarkNames).toEqual({ 'message-1': 'Saved' })
        expect(result.folders).toEqual([{ id: 'folder-1', name: 'Folder' }])
        expect(source.bookmarks).toBeUndefined()
    })
})

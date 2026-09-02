// @vitest-environment node
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import bookmarkStorePkg from './bookmarkStore.cjs'

const { createBookmarkStore } = bookmarkStorePkg as any

const databases: Database.Database[] = []

function createStore() {
    const database = new Database(':memory:')
    databases.push(database)
    return createBookmarkStore(database)
}

function compatibleDatabase() {
    return {
        bookmarkFolders: [{ id: 'folder-1', name: 'Favorites' }],
        characters: [{
            chaId: 'character-1',
            chats: [{
                id: 'chat-1',
                message: [{ chatId: 'message-1', data: '  bookmarked   body  ' }],
                bookmarks: ['message-1'],
                bookmarkNames: { 'message-1': 'Saved' },
                bookmarkFolderIds: { 'message-1': 'folder-1' },
            }],
        }],
    }
}

afterEach(() => {
    while (databases.length > 0) databases.pop()?.close()
})

describe('SQLite bookmark store', () => {
    it('migrates legacy chat fields once and removes the duplicate source', () => {
        const store = createStore()
        const database = compatibleDatabase()

        expect(store.migrateLegacyDatabase(database)).toEqual({ changed: true, migrated: true })
        expect(database).not.toHaveProperty('bookmarkFolders')
        expect(database.characters[0].chats[0]).not.toHaveProperty('bookmarks')
        expect(store.catalog()).toEqual(expect.objectContaining({
            folders: [],
            entries: [expect.objectContaining({
                characterId: 'character-1',
                chatId: 'chat-1',
                messageId: 'message-1',
                name: 'Saved',
                preview: 'bookmarked body',
                folderId: null,
            })],
        }))

        store.removeBookmarkEntry({
            characterId: 'character-1', chatId: 'chat-1', messageId: 'message-1',
        })
        const staleCompatibleCopy = compatibleDatabase()
        expect(store.migrateLegacyDatabase(staleCompatibleCopy).migrated).toBe(false)
        expect(store.catalog().entries).toEqual([])
    })

    it('replaces canonical rows when a full compatible backup is imported', () => {
        const store = createStore()
        store.migrateLegacyDatabase({ characters: [] })

        const imported = compatibleDatabase()
        expect(store.replaceDatabaseCompatibility(imported).importedChats).toBe(1)
        expect(store.compatibilityForTargets([
            { characterId: 'character-1', chatId: 'chat-1' },
        ])).toEqual({
            entries: [{
                characterId: 'character-1',
                chatId: 'chat-1',
                data: {
                    bookmarks: ['message-1'],
                    bookmarkNames: { 'message-1': 'Saved' },
                    bookmarkFolderIds: { 'message-1': 'folder-1' },
                },
            }],
            folders: [{ id: 'folder-1', name: 'Favorites' }],
        })
    })

    it('projects compatible fields for export and snapshots table state', () => {
        const store = createStore()
        store.replaceDatabaseCompatibility(compatibleDatabase())
        const exported = {
            characters: [{
                chaId: 'character-1',
                chats: [{ id: 'chat-1', message: [{ chatId: 'message-1', data: 'Body' }] }],
            }],
        }

        store.projectDatabaseCompatibility(exported)
        expect(exported).toEqual(expect.objectContaining({
            bookmarkFolders: [{ id: 'folder-1', name: 'Favorites' }],
        }))
        expect(exported.characters[0].chats[0]).toEqual(expect.objectContaining({
            bookmarks: ['message-1'],
            bookmarkNames: { 'message-1': 'Saved' },
        }))

        store.saveSnapshot('database/dbbackup-1.bin')
        store.removeBookmarkEntry({
            characterId: 'character-1', chatId: 'chat-1', messageId: 'message-1',
        })
        expect(store.restoreSnapshot('database/dbbackup-1.bin')).toBe(true)
        expect(store.catalog().entries).toHaveLength(1)
    })

    it('uncategorizes bookmarks when their folder is deleted', () => {
        const store = createStore()
        store.replaceDatabaseCompatibility(compatibleDatabase())
        store.replaceFolders([])
        expect(store.catalog().entries[0].folderId).toBeNull()
    })
})

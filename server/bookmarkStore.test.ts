// @vitest-environment node
import Database from './sqlite.cjs'
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
        bookmarkTags: [{ id: 'tag-1', name: 'Favorites' }],
        characters: [{
            chaId: 'character-1',
            chats: [{
                id: 'chat-1',
                message: [{ chatId: 'message-1', data: '  bookmarked   body  ' }],
                bookmarks: ['message-1'],
                bookmarkNames: { 'message-1': 'Saved' },
                bookmarkTagIds: { 'message-1': ['tag-1'] },
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
        expect(database).not.toHaveProperty('bookmarkTags')
        expect(database.characters[0].chats[0]).not.toHaveProperty('bookmarks')
        expect(store.catalog()).toEqual(expect.objectContaining({
            tags: [],
            entries: [expect.objectContaining({
                characterId: 'character-1',
                chatId: 'chat-1',
                messageId: 'message-1',
                name: 'Saved',
                preview: 'bookmarked body',
                tagIds: [],
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
                    bookmarkTagIds: { 'message-1': ['tag-1'] },
                },
            }],
            tags: [{ id: 'tag-1', name: 'Favorites' }],
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
            bookmarkTags: [{ id: 'tag-1', name: 'Favorites' }],
        }))
        expect(exported.characters[0].chats[0]).toEqual(expect.objectContaining({
            bookmarks: ['message-1'],
            bookmarkNames: { 'message-1': 'Saved' },
        }))

        store.saveSnapshot('database/dbbackup-1.bin')
        store.removeBookmarkEntry({
            characterId: 'character-1', chatId: 'chat-1', messageId: 'message-1',
        })
        const promoted = {
            characters: [{
                chaId: 'character-1',
                chats: [{ id: 'chat-1', message: [{ chatId: 'message-1', data: 'Body' }] }],
            }],
        }
        expect(store.projectSnapshotDatabaseCompatibility('database/dbbackup-1.bin', promoted)).toBe(true)
        expect(promoted.characters[0].chats[0]).toEqual(expect.objectContaining({
            bookmarks: ['message-1'],
            bookmarkNames: { 'message-1': 'Saved' },
        }))
        expect(store.catalog().entries).toHaveLength(0)
        expect(store.restoreSnapshot('database/dbbackup-1.bin')).toBe(true)
        expect(store.catalog().entries).toHaveLength(1)
    })

    it('commits and rolls back snapshot bodies with bookmark catalogs in one outer transaction', () => {
        const database = new Database(':memory:')
        databases.push(database)
        database.exec('CREATE TABLE snapshot_bodies (key TEXT PRIMARY KEY, value BLOB NOT NULL)')
        const store = createBookmarkStore(database)
        store.replaceDatabaseCompatibility(compatibleDatabase())
        const insertBody = database.prepare('INSERT INTO snapshot_bodies(key, value) VALUES (?, ?)')
        const deleteBody = database.prepare('DELETE FROM snapshot_bodies WHERE key = ?')
        const countBodies = database.prepare('SELECT COUNT(*) AS count FROM snapshot_bodies')
        const key = 'database/dbbackup-atomic.bin'

        const createSnapshot = database.transaction((fail: boolean) => {
            insertBody.run(key, Buffer.from('snapshot'))
            store.saveSnapshot(key)
            if (fail) throw new Error('injected failure')
        })

        expect(() => createSnapshot(true)).toThrow('injected failure')
        expect(countBodies.get()).toEqual({ count: 0 })
        expect(store.restoreSnapshot(key)).toBe(false)

        createSnapshot(false)
        expect(countBodies.get()).toEqual({ count: 1 })
        expect(store.restoreSnapshot(key)).toBe(true)

        const deleteSnapshot = database.transaction((fail: boolean) => {
            deleteBody.run(key)
            store.deleteSnapshot(key)
            if (fail) throw new Error('injected failure')
        })

        expect(() => deleteSnapshot(true)).toThrow('injected failure')
        expect(countBodies.get()).toEqual({ count: 1 })
        expect(store.restoreSnapshot(key)).toBe(true)

        deleteSnapshot(false)
        expect(countBodies.get()).toEqual({ count: 0 })
        expect(store.restoreSnapshot(key)).toBe(false)
    })

    it('removes a tag binding when its tag is deleted', () => {
        const store = createStore()
        store.replaceDatabaseCompatibility(compatibleDatabase())
        store.replaceTags([])
        expect(store.catalog().entries[0].tagIds).toEqual([])
    })
})

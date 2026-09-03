import { describe, expect, it } from 'vitest'
import type { Chat, Database } from '../storage/database.svelte'
import {
    applyBookmarkCompatibility,
    collectGlobalBookmarks,
    remapBookmarkFolders,
    stripBookmarkCompatibility,
} from './bookmarkData'
import type { BookmarkCatalog } from './bookmarkTypes'

function chat(overrides: Partial<Chat> = {}): Chat {
    return {
        id: 'room-1',
        name: 'Room',
        message: [],
        note: '',
        localLore: [],
        ...overrides,
    }
}

describe('server bookmark catalog projection', () => {
    it('joins server rows with current character and chat names', () => {
        const db = {
            characters: [{ chaId: 'character-1', name: 'Character', chats: [chat()] }],
        } as unknown as Database
        const catalog: BookmarkCatalog = {
            revision: 1,
            folders: [],
            entries: [{
                characterId: 'character-1', chatId: 'room-1', messageId: 'message-1',
                name: 'Saved', preview: 'Body', sortOrder: 0,
            }],
        }

        expect(collectGlobalBookmarks(db, catalog)).toEqual([expect.objectContaining({
            name: 'Saved', characterName: 'Character', chatName: 'Room',
            characterIndex: 0, chatIndex: 0,
        })])
    })

    it('injects original-compatible fields into an export clone', () => {
        const source = chat({ message: [{ chatId: 'message-1', role: 'char', data: 'Body' }] })
        const compatible = applyBookmarkCompatibility(source, {
            bookmarks: ['message-1'],
            bookmarkNames: { 'message-1': 'Saved' },
            bookmarkFolderIds: { 'message-1': 'folder-1' },
        })

        expect(compatible.bookmarks).toEqual(['message-1'])
        expect(compatible.bookmarkNames).toEqual({ 'message-1': 'Saved' })
        expect(compatible.bookmarkFolderIds).toEqual({ 'message-1': 'folder-1' })
        expect(source.bookmarks).toBeUndefined()
    })

    it('remaps imported folder collisions without changing message ids', () => {
        const value = chat({
            bookmarks: ['message-1'],
            bookmarkFolderIds: { 'message-1': 'old-folder' },
        })
        remapBookmarkFolders(value, { 'old-folder': 'new-folder' })
        expect(value.bookmarks).toEqual(['message-1'])
        expect(value.bookmarkFolderIds).toEqual({ 'message-1': 'new-folder' })
    })

    it('removes import-only compatibility fields after server ingestion', () => {
        const value = chat({
            bookmarks: ['message-1'],
            bookmarkNames: { 'message-1': 'Saved' },
            bookmarkFolderIds: { 'message-1': 'folder-1' },
        })
        stripBookmarkCompatibility(value)
        expect(value.bookmarks).toBeUndefined()
        expect(value.bookmarkNames).toBeUndefined()
        expect(value.bookmarkFolderIds).toBeUndefined()
    })
})

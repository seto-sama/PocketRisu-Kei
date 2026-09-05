import { writable } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { character, Chat, loreBook } from '../storage/database.svelte'

const mocks = vi.hoisted(() => ({
    DBState: { db: { characters: [] as character[] } },
    selectFile: vi.fn(), save: vi.fn(), hydrate: vi.fn(), dirty: vi.fn(), error: vi.fn(),
}))
vi.mock(import('../stores.svelte'), () => ({ DBState: mocks.DBState, selectedCharID: writable(0) }))
vi.mock(import('../util'), () => ({ selectSingleFile: mocks.selectFile }))
vi.mock(import('../globalApi.svelte'), () => ({ requestImmediateSave: mocks.save }))
vi.mock(import('../storage/chatStorage'), () => ({
    ensureChatHydrated: mocks.hydrate, getChatServerEtag: () => 'current-etag',
}))
vi.mock(import('../storage/chatWorkingCopy'), () => ({ markChatWorkingCopyDirty: mocks.dirty }))
vi.mock(import('../alert'), () => ({ alertError: mocks.error }))
vi.mock(import('../parser/chatVar.svelte'), () => ({}))
vi.mock(import('./modules'), () => ({}))
vi.mock(import('./lorebookPrompt'), () => ({}))

import { selectedCharID } from '../stores.svelte'
import { importLoreBook } from './lorebook.svelte'

const entry = (content: string) => ({ key: content, content } as loreBook)
const chat = (id: string) => ({ id, message: [], localLore: [entry(id)] } as Chat)
const character = (id: string) => ({
    chaId: id, chatPage: 0, chats: [chat(`${id}-1`), chat(`${id}-2`)], globalLore: [entry(id)],
} as character)
const importedFile = () => ({ data: Buffer.from(JSON.stringify({ type: 'risu', data: [entry('imported')] })) })

describe('lorebook import target', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        selectedCharID.set(0)
        mocks.DBState.db.characters = [character('a'), character('b')]
        mocks.selectFile.mockResolvedValue(importedFile())
        mocks.hydrate.mockImplementation(async (chats: Chat[], index: number) => chats[index])
    })

    it('appends to the current original character after selection and projection changes', async () => {
        mocks.selectFile.mockImplementation(async () => {
            const replacement = character('a')
            replacement.globalLore.push(entry('remote'))
            mocks.DBState.db.characters = [character('b'), replacement]
            selectedCharID.set(0)
            return importedFile()
        })
        await importLoreBook('global')
        expect(mocks.DBState.db.characters[1].globalLore.map(lore => lore.content)).toEqual(['a', 'remote', 'imported'])
        expect(mocks.DBState.db.characters[0].globalLore).toEqual([entry('b')])
        expect(mocks.save).toHaveBeenCalledWith({ characterIds: ['a'] })
    })

    it('imports into the original chat after reordering, hydration and replacement', async () => {
        mocks.selectFile.mockImplementation(async () => {
            const target = character('a')
            target.chats = [chat('a-2'), { id: 'a-1', _placeholder: true } as Chat]
            mocks.DBState.db.characters = [character('b'), target]
            return importedFile()
        })
        mocks.hydrate.mockImplementation(async () => {
            const target = character('a')
            target.chats[0].localLore.push(entry('remote'))
            target.chatPage = 1
            mocks.DBState.db.characters = [character('b'), target]
            return target.chats[0]
        })
        await importLoreBook('local')
        const target = mocks.DBState.db.characters[1]
        expect(target.chats[0].localLore.map(lore => lore.content)).toEqual(['a-1', 'remote', 'imported'])
        expect(target.chats[1].localLore).toEqual([entry('a-2')])
        expect(mocks.dirty).toHaveBeenCalledWith('a', 'a-1', 'current-etag')
        expect(mocks.save).toHaveBeenCalledWith({ chatTargets: [{ characterId: 'a', chatId: 'a-1' }] })
    })

    it.each(['character-deleted', 'character-trashed', 'chat-deleted', 'hydration-failed'])('does not save an unavailable target: %s', async (reason) => {
        mocks.selectFile.mockImplementation(async () => {
            const target = mocks.DBState.db.characters[0]
            if (reason === 'character-deleted') mocks.DBState.db.characters.shift()
            if (reason === 'character-trashed') target.trashTime = 1
            if (reason === 'chat-deleted') target.chats.shift()
            if (reason === 'hydration-failed') {
                target.chats[0] = { id: 'a-1', _placeholder: true } as Chat
                mocks.hydrate.mockResolvedValue(null)
            }
            return importedFile()
        })
        await importLoreBook('local')
        expect(mocks.save).not.toHaveBeenCalled()
        expect(mocks.dirty).not.toHaveBeenCalled()
        expect(mocks.error).not.toHaveBeenCalled()
    })

    it('does not restore a chat removed during hydration', async () => {
        mocks.DBState.db.characters[0].chats[0] = { id: 'a-1', _placeholder: true } as Chat
        mocks.hydrate.mockImplementation(async () => {
            const removed = mocks.DBState.db.characters[0].chats.shift()
            return removed
        })
        await importLoreBook('local')
        expect(mocks.DBState.db.characters[0].chats).toEqual([chat('a-2')])
        expect(mocks.save).not.toHaveBeenCalled()
    })

    it('edits a loaded chat without hydration and still explicitly saves its target', async () => {
        await importLoreBook('local')
        expect(mocks.hydrate).not.toHaveBeenCalled()
        expect(mocks.DBState.db.characters[0].chats[0].localLore).toEqual([entry('a-1'), entry('imported')])
        expect(mocks.save).toHaveBeenCalledWith({ chatTargets: [{ characterId: 'a', chatId: 'a-1' }] })
    })
})

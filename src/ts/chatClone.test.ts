import { describe, expect, it } from 'vitest'
import { reissueMessageIds } from './chatClone'
import type { Chat } from './storage/database.svelte'

function makeChat(): Chat {
    return {
        name: 'source',
        note: '',
        localLore: [],
        message: [
            { role: 'user', data: 'one', chatId: 'm1' },
            { role: 'char', data: 'two', chatId: 'm2' },
            { role: 'user', data: 'three', chatId: 'm3' },
            { role: 'char', data: 'four' },
        ],
        hypaV3Data: {
            summaries: [
                { text: 'first', chatMemos: [null, 'm1'], isImportant: false },
                { text: 'middle', chatMemos: ['m2'], isImportant: true },
                { text: 'future', chatMemos: ['m3'], isImportant: false },
                { text: 'legacy orphan', chatMemos: ['missing'], isImportant: false },
            ],
            metrics: {
                lastImportantSummaries: [1],
                lastRecentSummaries: [],
                lastSimilarSummaries: [],
                lastRandomSummaries: [],
            },
        } as any,
        bookmarks: ['m1', 'm3'],
        bookmarkNames: { m1: 'one', m3: 'three' },
        bookmarkTagIds: { m1: ['tag-a'], m3: ['tag-b'] },
    }
}

describe('reissueMessageIds', () => {
    it('gives a full copy independent ids and remaps message references', () => {
        const source = makeChat()
        const sourceIds = source.message.map(message => message.chatId)
        const copy = reissueMessageIds(structuredClone(source), sourceIds)
        const ids = copy.message.map(message => message.chatId)

        expect(ids.every(Boolean)).toBe(true)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids.some(id => sourceIds.includes(id))).toBe(false)
        expect(copy.hypaV3Data?.summaries.map(summary => summary.chatMemos)).toEqual([
            [null, ids[0]],
            [ids[1]],
            [ids[2]],
            ['missing'],
        ])
        expect(copy.hypaV3Data?.metrics).toBeDefined()
        expect(copy.bookmarks).toEqual([ids[0], ids[2]])
        expect(copy.bookmarkNames).toEqual({ [ids[0]]: 'one', [ids[2]]: 'three' })
        expect(copy.bookmarkTagIds).toEqual({ [ids[0]]: ['tag-a'], [ids[2]]: ['tag-b'] })
        expect(source.message[0].chatId).toBe('m1')
    })

    it('drops branch-only memory and bookmark references but preserves old orphans', () => {
        const source = makeChat()
        const sourceIds = source.message.map(message => message.chatId)
        const branch = structuredClone(source)
        branch.message = branch.message.slice(0, 2)
        reissueMessageIds(branch, sourceIds)

        expect(branch.hypaV3Data?.summaries.map(summary => summary.text)).toEqual([
            'first',
            'middle',
            'legacy orphan',
        ])
        expect(branch.hypaV3Data?.metrics).toBeUndefined()
        expect(branch.bookmarks).toEqual([branch.message[0].chatId])
        expect(Object.keys(branch.bookmarkNames ?? {})).toEqual([branch.message[0].chatId])
        expect(Object.keys(branch.bookmarkTagIds ?? {})).toEqual([branch.message[0].chatId])
    })

    it('handles chats without memory or bookmark compatibility data', () => {
        const chat: Chat = {
            name: '',
            note: '',
            localLore: [],
            message: [{ role: 'user', data: 'hello' }],
        }
        expect(() => reissueMessageIds(chat, [])).not.toThrow()
        expect(chat.message[0].chatId).toBeTruthy()
    })
})

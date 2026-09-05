import { describe, expect, it } from 'vitest'
import type { Message } from 'src/ts/storage/database.svelte'
import {
    collectChatInlayViewerEntries,
    isEmptyChatInlayMessage,
    removeChatInlayOccurrence,
    removeCurrentEmptyInlaySwipe,
} from './chatInlayViewer'

describe('chat inlay viewer references', () => {
    it('collects first-message and message occurrences in display order', () => {
        const messages = [
            { role: 'user', data: '{{inlayed::same}} text {{inlay::same}}' },
            { role: 'char', data: '{{inlayeddata::other}}' },
        ] satisfies Message[]

        expect(collectChatInlayViewerEntries('{{inlayed::first}}', messages)).toEqual([
            { id: 'first', messageIndex: -1, occurrence: 0 },
            { id: 'same', messageIndex: 0, occurrence: 0 },
            { id: 'same', messageIndex: 0, occurrence: 1 },
            { id: 'other', messageIndex: 1, occurrence: 0 },
        ])
    })

    it('removes only the selected occurrence of a repeated inlay', () => {
        const source = '{{inlayed::same}} middle {{inlay::same}}'
        expect(removeChatInlayOccurrence(source, { id: 'same', occurrence: 1 }))
            .toBe('{{inlayed::same}} middle ')
    })

    it('recognizes a message emptied by removing its only inlay', () => {
        const source = removeChatInlayOccurrence('  {{inlayed::only}}\n', {
            id: 'only',
            occurrence: 0,
        })
        expect(isEmptyChatInlayMessage(source)).toBe(true)
    })

    it('removes only the current swipe and collapses a sole remaining swipe', () => {
        const message: Message = {
            role: 'char',
            data: '{{inlayed::remove}}',
            swipes: ['{{inlayed::remaining}}', '{{inlayed::remove}}'],
            swipeId: 1,
            swipeMetadata: [
                { chatId: 'remaining-id', time: 10 },
                { chatId: 'removed-id', time: 20 },
            ],
        }

        expect(removeCurrentEmptyInlaySwipe(message)).toBe(true)
        expect(message).toMatchObject({ data: '{{inlayed::remaining}}', chatId: 'remaining-id', time: 10 })
        expect(collectChatInlayViewerEntries('', [message])).toEqual([
            { id: 'remaining', messageIndex: 0, occurrence: 0 },
        ])
        expect(message.swipes).toBeUndefined()
        expect(message.swipeId).toBeUndefined()
        expect(message.swipeMetadata).toBeUndefined()
    })

    it('leaves a single-swipe message for the caller to delete', () => {
        const message: Message = {
            role: 'char',
            data: '{{inlayed::only}}',
            swipes: ['{{inlayed::only}}'],
            swipeId: 0,
        }

        expect(removeCurrentEmptyInlaySwipe(message)).toBe(false)
        expect(message.swipes).toEqual(['{{inlayed::only}}'])
    })
})

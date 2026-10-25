import { describe, expect, it } from 'vitest'
import type { Message } from '../storage/database.svelte'
import { applyScriptMessageDeletion } from './scriptMessageDeletion'

function response(chatId: string, disabled = false): Message {
    return { role: 'char', chatId, disabled, data: 'selected', swipes: ['previous', 'selected'], swipeId: 1 }
}

describe('script message deletion', () => {
    it.each(['response', 'later'])('removes only a swipe from a single %s deletion', target => {
        const current = response('current')
        const later = response('later', true)
        const comment: Message = { role: 'char', chatId: 'comment', data: 'branch info', isComment: true }
        const chat = { message: [current, later, comment] }
        const removed = target === 'response' ? current : later

        applyScriptMessageDeletion(chat, chat.message.filter(message => message !== removed))

        expect(chat.message).toEqual([current, later, comment])
        expect(removed.data).toBe('previous')
        expect(removed.swipes).toBeUndefined()
        expect(comment.data).toBe('branch info')
    })

    it('deletes an earlier message with all its alternatives', () => {
        const earlier = response('earlier')
        const current = response('current')
        const chat = { message: [earlier, current] }

        applyScriptMessageDeletion(chat, [current])

        expect(chat.message).toEqual([current])
        expect(current.swipes).toEqual(['previous', 'selected'])
    })

    it('deletes multiple messages with all their alternatives', () => {
        const chat = { message: [response('first'), response('last')] }

        applyScriptMessageDeletion(chat, [])

        expect(chat.message).toEqual([])
    })

    it('deletes the last message if no alternative remains', () => {
        const chat = { message: [{ role: 'char', data: '', chatId: 'only' } satisfies Message] }

        applyScriptMessageDeletion(chat, [])

        expect(chat.message).toEqual([])
    })

})

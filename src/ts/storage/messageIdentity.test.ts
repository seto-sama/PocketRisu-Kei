import { describe, expect, it } from 'vitest'
import { ensureMessageId, getMessagePromptIdentity } from './messageIdentity'
import type { Message } from './database.svelte'

describe('message identity', () => {
    it('uses the room message for memory and the selected swipe for provider context', () => {
        const message: Message = {
            role: 'char', data: 'selected', chatId: 'branch-message',
            swipes: ['selected', 'other'], swipeId: 0,
            swipeMetadata: [{ chatId: 'selected-response' }, { chatId: 'other-response' }],
        }
        expect(getMessagePromptIdentity(message)).toEqual({
            memo: 'branch-message', responseId: 'selected-response',
        })
        message.swipeId = 1
        expect(getMessagePromptIdentity(message)).toEqual({
            memo: 'branch-message', responseId: 'other-response',
        })
        delete message.swipeMetadata
        expect(getMessagePromptIdentity(message)).toEqual({
            memo: 'branch-message', responseId: 'branch-message',
        })
    })

    it('assigns an id once and preserves it across normalization', () => {
        const message: { chatId?: string } = {}

        const normalized = ensureMessageId(message)
        const firstId = normalized.chatId

        expect(firstId).toMatch(/^[0-9a-f-]{36}$/)
        expect(ensureMessageId(message).chatId).toBe(firstId)
    })

    it('preserves an imported id', () => {
        expect(ensureMessageId({ chatId: 'imported-message' }).chatId)
            .toBe('imported-message')
    })
})

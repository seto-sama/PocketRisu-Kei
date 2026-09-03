import { describe, expect, it } from 'vitest'
import { ensureMessageId } from './messageIdentity'

describe('message identity', () => {
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

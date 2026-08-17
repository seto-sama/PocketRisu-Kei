import { describe, expect, it } from 'vitest'
import { revenantTranslationTargetsMatch } from '../auxiliary'
import { prepareRevenantTranslationRequest } from './translationRecovery'
import type { RevenantChatMessageTranslationTarget } from '../types'

const target: RevenantChatMessageTranslationTarget = {
    kind: 'chat-message',
    messageChatId: 'message-1',
    messageIndex: 12,
    swipeId: 2,
}

describe('revenant translation targets', () => {
    it('persists the message and swipe target in the operation context', () => {
        const request = prepareRevenantTranslationRequest('hello', false, target)

        expect(request.operationContext.target).toEqual(target)
        expect(prepareRevenantTranslationRequest('other', false).operationContext.target).toBeNull()
    })

    it('follows a message id when its index moves', () => {
        expect(revenantTranslationTargetsMatch(target, {
            ...target,
            messageIndex: 20,
        })).toBe(true)
    })

    it('falls back to the index for messages without an id', () => {
        const withoutId = { ...target, messageChatId: null }
        expect(revenantTranslationTargetsMatch(withoutId, withoutId)).toBe(true)
        expect(revenantTranslationTargetsMatch(withoutId, {
            ...withoutId,
            messageIndex: 13,
        })).toBe(false)
    })

    it('does not attach a result to a different swipe', () => {
        expect(revenantTranslationTargetsMatch(target, {
            ...target,
            swipeId: 3,
        })).toBe(false)
    })
})

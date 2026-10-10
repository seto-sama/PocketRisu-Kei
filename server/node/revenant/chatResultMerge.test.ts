// @vitest-environment node
import { describe, expect, it } from 'vitest'
import mergePkg from './chatResultMerge.cjs'

const {
    mergeGenerationChatResult,
} = mergePkg as any

describe('generation chat result rebase', () => {
    it('preserves an edit to an earlier message while inserting the generated response', () => {
        const base = {
            id: 'room',
            message: [
                { chatId: 'old', role: 'char', data: 'old text' },
                { chatId: 'user', role: 'user', data: 'question' },
            ],
        }
        const result = {
            ...base,
            message: [...base.message, { chatId: 'generated', role: 'char', data: 'answer' }],
        }
        const current = structuredClone(base)
        current.message[0].data = 'edited while streaming'

        const merged = mergeGenerationChatResult(base, result, current, { messageChatId: 'generated' })

        expect(merged.message).toEqual([
            { chatId: 'old', role: 'char', data: 'edited while streaming' },
            { chatId: 'user', role: 'user', data: 'question' },
            { chatId: 'generated', role: 'char', data: 'answer' },
        ])
    })

    it('rejects concurrent edits to the reroll target', () => {
        const base = {
            id: 'room',
            message: [{ chatId: 'target', role: 'char', data: 'original', swipes: ['original'], swipeId: 0 }],
        }
        const result = {
            id: 'room',
            message: [{ chatId: 'generated', role: 'char', data: 'rerolled', swipes: ['original', 'rerolled'], swipeId: 1 }],
        }
        const current = {
            id: 'room',
            message: [{ chatId: 'target', role: 'char', data: 'manually edited' }],
        }

        expect(() => mergeGenerationChatResult(base, result, current, {
            messageChatId: 'generated',
            rerollSnapshot: {
                targetMessage: base.message[0], targetIndex: 0, trailingMessages: [],
            },
        })).toThrow('overlaps concurrent chat edits')
    })

    it('rebases a reroll swipe while preserving a different edited message', () => {
        const target = {
            chatId: 'target', role: 'char', data: 'original', swipes: ['original'], swipeId: 0,
        }
        const base = {
            id: 'room',
            message: [
                { chatId: 'old', role: 'user', data: 'old' },
                target,
            ],
        }
        const rerolled = {
            chatId: 'generated', role: 'char', data: 'rerolled',
            swipes: ['original', 'rerolled'], swipeId: 1,
        }
        const result = { id: 'room', message: [base.message[0], rerolled] }
        const current = structuredClone(base)
        current.message[0].data = 'edited old message'

        const merged = mergeGenerationChatResult(base, result, current, {
            messageChatId: 'generated',
            rerollSnapshot: { targetMessage: target, targetIndex: 1, trailingMessages: [] },
        })

        expect(merged.message[0].data).toBe('edited old message')
        expect(merged.message[1]).toEqual(rerolled)
    })
})

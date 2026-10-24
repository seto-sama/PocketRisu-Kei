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
            scriptstate: { $score: '10', $display: 'full' },
        }
        const result = {
            ...base,
            message: [...base.message, { chatId: 'generated', role: 'char', data: 'answer' }],
            scriptstate: { $score: '13', $display: 'full' },
        }
        const current = structuredClone(base)
        current.message[0].data = 'edited while streaming'
        current.scriptstate.$display = 'light'

        const merged = mergeGenerationChatResult(base, result, current, { messageChatId: 'generated' })

        expect(merged.scriptstate).toEqual({ $score: '13', $display: 'light' })
        expect(merged.message).toEqual([
            { chatId: 'old', role: 'char', data: 'edited while streaming' },
            { chatId: 'user', role: 'user', data: 'question' },
            { chatId: 'generated', role: 'char', data: 'answer' },
        ])
    })

    it.each([false, true])('rejects concurrent edits to the reroll target when deleted: %s', deleted => {
        const base = {
            id: 'room',
            message: [{ chatId: 'target', role: 'char', data: 'original', swipes: ['original'], swipeId: 0 }],
        }
        const result = {
            id: 'room',
            message: deleted ? [] : [{ chatId: 'generated', role: 'char', data: 'rerolled', swipes: ['original', 'rerolled'], swipeId: 1 }],
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

    it.each(['rerolled', ''])('rebases a reroll swipe containing %j while preserving a different edited message', text => {
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
            chatId: 'generated', role: 'char', data: text,
            swipes: ['original', text], swipeId: 1,
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

    it.each([false, true])('removes the reroll history cut by output triggers, keeping earlier messages: %s', keepEarlier => {
        const target = {
            chatId: 'target', role: 'char', data: 'original',
            swipes: ['first answer', 'original'], swipeId: 1,
        }
        const trailing = { chatId: 'comment', role: 'user', data: 'note', isComment: true }
        const base = {
            id: 'room',
            message: [{ chatId: 'user', role: 'user', data: 'question' }, target, trailing],
        }
        const result = { id: 'room', message: keepEarlier ? [base.message[0]] : [] }
        const current = structuredClone(base)
        if (keepEarlier) current.message[0].data = 'edited question'

        const merged = mergeGenerationChatResult(base, result, current, {
            messageChatId: 'generated',
            rerollSnapshot: { targetMessage: target, targetIndex: 1, trailingMessages: [trailing] },
        })

        expect(merged.message).toEqual(keepEarlier ? [current.message[0]] : [])
        expect(merged.isStreaming).toBe(false)
    })
})

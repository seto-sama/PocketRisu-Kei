// @vitest-environment node
import { describe, expect, it } from 'vitest'
import mergePkg from './chatResultMerge.cjs'

const {
    isStaleGenerationTargetWrite,
    mergeConcurrentChatEdit,
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

        const merged = mergeGenerationChatResult(base, result, current, {
            messageChatId: 'generated', isContinuation: false,
        })

        expect(merged.message).toEqual([
            { chatId: 'old', role: 'char', data: 'edited while streaming' },
            { chatId: 'user', role: 'user', data: 'question' },
            { chatId: 'generated', role: 'char', data: 'answer' },
        ])
    })

    it('rejects concurrent edits to the same continuation target', () => {
        const base = {
            id: 'room',
            message: [{ chatId: 'target', role: 'char', data: 'prefix' }],
        }
        const result = {
            id: 'room',
            message: [{ chatId: 'generated', role: 'char', data: 'prefix generated' }],
        }
        const current = {
            id: 'room',
            message: [{ chatId: 'target', role: 'char', data: 'manually edited' }],
        }

        expect(() => mergeGenerationChatResult(base, result, current, {
            messageChatId: 'generated', isContinuation: true,
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

    it('combines edits from two clients while excluding their live generation projections', () => {
        const base = {
            id: 'room',
            message: [
                { chatId: 'first', role: 'user', data: 'first' },
                { chatId: 'second', role: 'user', data: 'second' },
            ],
        }
        const current = structuredClone(base)
        current.message[0].data = 'edited by A'
        current.message.push({ chatId: 'generated', role: 'char', data: 'A projection' })
        const editedByB = structuredClone(base)
        editedByB.message[1].data = 'edited by B'
        editedByB.message.push({ chatId: 'generated', role: 'char', data: 'B projection' })

        const merged = mergeConcurrentChatEdit(base, editedByB, current, {
            messageChatId: 'generated', isContinuation: false,
        })

        expect(merged.message).toEqual([
            { chatId: 'first', role: 'user', data: 'edited by A' },
            { chatId: 'second', role: 'user', data: 'edited by B' },
            { chatId: 'generated', role: 'char', data: 'A projection' },
        ])
    })

    it('rejects two different edits to the same earlier message', () => {
        const base = {
            id: 'room',
            message: [{ chatId: 'earlier', role: 'user', data: 'before' }],
        }
        const current = {
            id: 'room',
            message: [{ chatId: 'earlier', role: 'user', data: 'edited by A' }],
        }
        const editedByB = {
            id: 'room',
            message: [{ chatId: 'earlier', role: 'user', data: 'edited by B' }],
        }

        expect(() => mergeConcurrentChatEdit(base, editedByB, current, {
            messageChatId: 'generated',
        })).toThrow('overlaps concurrent chat edits')
    })

    it('does not treat reroll-only trailing message removal as a client edit', () => {
        const target = { chatId: 'target', role: 'char', data: 'old response' }
        const trailing = { chatId: 'comment', role: 'user', data: 'branch note', isComment: true }
        const base = {
            id: 'room',
            message: [
                { chatId: 'earlier', role: 'user', data: 'earlier' },
                target,
                trailing,
            ],
        }
        const current = structuredClone(base)
        const rerollProjection = {
            id: 'room',
            message: [
                { chatId: 'earlier', role: 'user', data: 'edited while rerolling' },
                { chatId: 'generated', role: 'char', data: 'live projection' },
            ],
        }

        const merged = mergeConcurrentChatEdit(base, rerollProjection, current, {
            messageChatId: 'generated',
            rerollSnapshot: {
                targetMessage: target,
                targetIndex: 1,
                trailingMessages: [trailing],
            },
        })

        expect(merged.message).toEqual([
            { chatId: 'earlier', role: 'user', data: 'edited while rerolling' },
            target,
            trailing,
        ])
    })

    it('recognizes a pre-reroll body trying to replace the materialized target', () => {
        const original = { chatId: 'original', role: 'char', data: 'old' }
        const operation = {
            messageChatId: 'generated',
            rerollSnapshot: { targetMessage: original, targetIndex: 1, trailingMessages: [] },
        }
        const stale = {
            id: 'room',
            message: [{ chatId: 'user', role: 'user', data: 'prompt' }, original],
        }
        const canonical = {
            id: 'room',
            message: [
                { chatId: 'user', role: 'user', data: 'prompt' },
                { chatId: 'generated', role: 'char', data: 'cancelled partial' },
            ],
        }

        expect(isStaleGenerationTargetWrite(stale, canonical, operation)).toBe(true)
        expect(isStaleGenerationTargetWrite(canonical, canonical, operation)).toBe(false)

        const rebased = mergeConcurrentChatEdit(stale, stale, canonical, operation)
        expect(rebased.message[1]).toEqual(canonical.message[1])
    })
})

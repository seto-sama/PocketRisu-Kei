import { describe, expect, it } from 'vitest'
import type { Chat, Message } from '../../storage/database.svelte'
import { commitCancelledGenerationProjection } from './chatCancellation'

function chat(message: Message[]): Chat {
    return { message, isStreaming: true } as Chat
}

describe('commitCancelledGenerationProjection', () => {
    it('keeps the response received before a detached generation was cancelled', () => {
        const recovering = {
            role: 'char', data: '', chatId: 'generation-1',
            isRecovering: true, recoveryDisplayData: 'partial answer',
        } as Message
        const current = chat([
            { role: 'user', data: 'hello', chatId: 'user-1' },
            recovering,
        ])

        commitCancelledGenerationProjection(current, {
            messageChatId: 'generation-1',
            content: recovering.recoveryDisplayData!,
            isContinuation: false,
            targetMessage: recovering,
        })

        expect(current.message[1]).toEqual({
            role: 'char', data: 'partial answer', chatId: 'generation-1',
        })
        expect(current.isStreaming).toBe(false)
    })

    it('keeps a partial continuation on the existing assistant message', () => {
        const recovering = {
            role: 'char', data: 'original', chatId: 'assistant-1',
            isRecovering: true, recoveryDisplayData: 'original continued',
        } as Message
        const current = chat([recovering])

        commitCancelledGenerationProjection(current, {
            messageChatId: 'generation-1',
            content: recovering.recoveryDisplayData!,
            isContinuation: true,
            targetMessage: recovering,
        })

        expect(current.message[0]).toEqual({
            role: 'char', data: 'original continued', chatId: 'generation-1',
        })
    })

    it('adds a cancelled reroll projection as the active swipe', () => {
        const original = {
            role: 'char', data: 'old answer', chatId: 'assistant-1',
            swipes: ['old answer'], swipeId: 0,
        } as Message
        const recovering = {
            ...original,
            isRecovering: true,
            recoveryDisplayData: 'partial reroll',
        } as Message
        const trailing = {
            role: 'user', data: 'comment', isComment: true, chatId: 'comment-1',
        } as Message
        const current = chat([
            { role: 'user', data: 'hello', chatId: 'user-1' },
            recovering,
        ])

        commitCancelledGenerationProjection(current, {
            messageChatId: 'generation-1',
            content: recovering.recoveryDisplayData!,
            isContinuation: false,
            targetMessage: recovering,
            rerollSnapshot: {
                targetMessage: original,
                targetIndex: 1,
                trailingMessages: [trailing],
            },
        })

        expect(current.message[1]).toMatchObject({
            data: 'partial reroll',
            chatId: 'generation-1',
            swipes: ['old answer', 'partial reroll'],
            swipeId: 1,
        })
        expect(current.message[2]).toEqual(trailing)
    })

    it('does not leave an empty assistant placeholder when no output arrived', () => {
        const recovering = {
            role: 'char', data: '', chatId: 'generation-1', isRecovering: true,
        } as Message
        const current = chat([recovering])

        commitCancelledGenerationProjection(current, {
            messageChatId: 'generation-1',
            content: '',
            isContinuation: false,
            targetMessage: recovering,
        })

        expect(current.message).toEqual([])
    })

    it('restores the complete previous branch when a reroll fails before output', () => {
        const original = {
            role: 'char', data: 'old answer', chatId: 'assistant-1',
            swipes: ['old answer'], swipeId: 0,
        } as Message
        const trailing = {
            role: 'user', data: 'comment', isComment: true, chatId: 'comment-1',
        } as Message
        const placeholder = {
            role: 'char', data: '', chatId: 'generation-1',
        } as Message
        const current = chat([
            { role: 'user', data: 'hello', chatId: 'user-1' },
            placeholder,
        ])

        commitCancelledGenerationProjection(current, {
            messageChatId: 'generation-1',
            content: '',
            isContinuation: false,
            targetMessage: placeholder,
            rerollSnapshot: {
                targetMessage: original,
                targetIndex: 1,
                trailingMessages: [trailing],
            },
        })

        expect(current.message).toEqual([
            { role: 'user', data: 'hello', chatId: 'user-1' },
            original,
            trailing,
        ])
        expect(current.isStreaming).toBe(false)
    })
})

import { describe, expect, it } from 'vitest'
import type { Chat, Message } from '../../../storage/database.svelte'
import { ensureGenerationMessageTarget } from './chatGenerationTarget'

function chat(message: Message[]): Chat {
    return { message } as Chat
}

describe('ensureGenerationMessageTarget', () => {
    it('recreates a placeholder removed by a remote chat refresh', () => {
        const current = chat([
            { role: 'user', data: 'hello', chatId: 'user-1' },
        ])

        const target = ensureGenerationMessageTarget(current, {
            messageChatId: 'generation-1',
            characterId: 'character-1',
            isContinuation: false,
        })

        target.message.data = 'streamed answer'
        expect(current.message[1]).toMatchObject({
            role: 'char',
            data: 'streamed answer',
            chatId: 'generation-1',
        })
    })

    it('rebinds a refreshed continuation target to the generation id', () => {
        const current = chat([
            { role: 'char', data: 'original answer', chatId: 'assistant-1' },
        ])

        const target = ensureGenerationMessageTarget(current, {
            messageChatId: 'generation-1',
            characterId: 'character-1',
            isContinuation: true,
        })

        expect(target.index).toBe(0)
        expect(target.message).toMatchObject({
            data: 'original answer',
            chatId: 'generation-1',
        })
    })

    it('replaces a remotely restored reroll branch with one placeholder', () => {
        const original = {
            role: 'char', data: 'old answer', chatId: 'assistant-1',
        } as Message
        const current = chat([
            { role: 'user', data: 'hello', chatId: 'user-1' },
            original,
            { role: 'user', data: 'trailing comment', chatId: 'comment-1' },
        ])

        const target = ensureGenerationMessageTarget(current, {
            messageChatId: 'generation-1',
            characterId: 'character-1',
            isContinuation: false,
            rerollSnapshot: {
                targetMessage: original,
                targetIndex: 1,
                trailingMessages: [current.message[2]],
            },
        })

        expect(target.index).toBe(1)
        expect(current.message).toHaveLength(2)
        expect(current.message[1]).toMatchObject({
            data: '',
            chatId: 'generation-1',
        })
    })
})

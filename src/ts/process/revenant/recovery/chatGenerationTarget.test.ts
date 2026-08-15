import { describe, expect, it } from 'vitest'
import type { Chat, Message } from '../../../storage/database.svelte'
import {
    ensureGenerationMessageTarget,
    setGenerationMessageContent,
} from './chatGenerationTarget'

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

    it('commits reroll content into the selected swipe', () => {
        const original = {
            role: 'char',
            data: 'old answer',
            chatId: 'assistant-1',
            time: 100,
            generationInfo: { generationId: 'assistant-1', model: 'old-model' },
            promptInfo: { promptName: 'old-preset' },
            swipes: ['first answer', 'old answer'],
            swipeId: 1,
        } as Message
        const current = chat([original])
        const target = ensureGenerationMessageTarget(current, {
            messageChatId: 'generation-1',
            characterId: 'character-1',
            isContinuation: false,
            generationInfo: { generationId: 'generation-1', model: 'new-model' },
            promptInfo: { promptName: 'new-preset' },
            rerollSnapshot: {
                targetMessage: original,
                targetIndex: 0,
                trailingMessages: [],
            },
        })

        setGenerationMessageContent(target.message, 'new answer')

        expect(current.message).toHaveLength(1)
        expect(current.message[0]).toMatchObject({
            data: 'new answer',
            swipes: ['first answer', 'old answer', 'new answer'],
            swipeId: 2,
            chatId: 'generation-1',
            swipeMetadata: [
                {},
                {
                    chatId: 'assistant-1',
                    time: 100,
                    generationInfo: { generationId: 'assistant-1', model: 'old-model' },
                    promptInfo: { promptName: 'old-preset' },
                },
                {
                    chatId: 'generation-1',
                    generationInfo: { generationId: 'generation-1', model: 'new-model' },
                    promptInfo: { promptName: 'new-preset' },
                },
            ],
        })
    })

    it('preserves an existing diagnostic context for every swipe', () => {
        const original = {
            role: 'char',
            data: 'second answer',
            chatId: 'generation-2',
            swipes: ['first answer', 'second answer'],
            swipeId: 1,
            swipeMetadata: [
                { chatId: 'generation-1', generationInfo: { generationId: 'generation-1' } },
                { chatId: 'generation-2', generationInfo: { generationId: 'generation-2' } },
            ],
        } as Message
        const current = chat([original])

        ensureGenerationMessageTarget(current, {
            messageChatId: 'generation-3',
            characterId: 'character-1',
            isContinuation: false,
            generationInfo: { generationId: 'generation-3' },
            rerollSnapshot: {
                targetMessage: original,
                targetIndex: 0,
                trailingMessages: [],
            },
        })

        expect(current.message[0].swipeMetadata?.map(metadata => metadata.chatId)).toEqual([
            'generation-1',
            'generation-2',
            'generation-3',
        ])
    })
})

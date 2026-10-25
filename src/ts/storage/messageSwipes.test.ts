import { describe, expect, it } from 'vitest'
import type { Message } from './database.svelte'
import { removeActiveSwipe } from './messageSwipes'

describe('removeActiveSwipe', () => {
    it('removes the active middle swipe and selects its parallel metadata', () => {
        const message: Message = {
            role: 'char',
            data: 'second',
            chatId: 'second-chat',
            time: 20,
            generationInfo: { model: 'second-model' },
            promptInfo: { promptName: 'second-prompt' },
            swipes: ['first', 'second', 'third'],
            swipeId: 1,
            swipeMetadata: [
                { chatId: 'first-chat', time: 10 },
                { chatId: 'second-chat', time: 20 },
                { chatId: 'third-chat', time: 30, generationInfo: { model: 'third-model' } },
            ],
        }

        expect(removeActiveSwipe(message)).toBe(true)
        expect(message.data).toBe('third')
        expect(message.swipes).toEqual(['first', 'third'])
        expect(message.swipeMetadata).toEqual([
            { chatId: 'first-chat', time: 10 },
            { chatId: 'third-chat', time: 30, generationInfo: { model: 'third-model' } },
        ])
        expect(message.swipeId).toBe(1)
        expect(message.chatId).toBe('third-chat')
        expect(message.time).toBe(30)
        expect(message.generationInfo).toEqual({ model: 'third-model' })
        expect(message.promptInfo).toEqual({ promptName: 'second-prompt' })
    })

    it('leaves messages without alternatives or with an invalid active index unchanged', () => {
        const singleSwipe: Message = {
            role: 'char',
            data: 'only',
            swipes: ['only'],
            swipeId: 0,
        }
        const invalidIndex: Message = {
            role: 'char',
            data: 'first',
            swipes: ['first', 'second'],
            swipeId: 2,
        }

        const originalSingleSwipe = structuredClone(singleSwipe)
        const originalInvalidIndex = structuredClone(invalidIndex)
        expect(removeActiveSwipe(singleSwipe)).toBe(false)
        expect(removeActiveSwipe(invalidIndex)).toBe(false)
        expect(singleSwipe).toEqual(originalSingleSwipe)
        expect(invalidIndex).toEqual(originalInvalidIndex)
    })
})

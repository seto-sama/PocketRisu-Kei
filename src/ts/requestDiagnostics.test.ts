import { describe, expect, it } from 'vitest'
import type { Message } from './storage/database.svelte'
import { resolveRequestDiagnosticContext } from './requestDiagnostics'

describe('resolveRequestDiagnosticContext', () => {
    it('uses message-level metadata for a response without swipes', () => {
        const message = {
            role: 'char',
            data: 'answer',
            chatId: 'generation-1',
            time: 100,
            generationInfo: { generationId: 'generation-1', model: 'model-1' },
            promptInfo: { promptName: 'preset-1' },
        } as Message

        expect(resolveRequestDiagnosticContext(message)).toMatchObject({
            requestKey: 'generation-1',
            time: 100,
            hasSwipeSet: false,
            generationInfo: { generationId: 'generation-1', model: 'model-1' },
            promptInfo: { promptName: 'preset-1' },
        })
    })

    it('uses only the selected swipe metadata when it is available', () => {
        const message = {
            role: 'char',
            data: 'old answer',
            chatId: 'newest-generation',
            generationInfo: { generationId: 'newest-generation' },
            swipes: ['old answer', 'new answer'],
            swipeId: 0,
            swipeMetadata: [
                {
                    chatId: 'old-generation',
                    time: 100,
                    generationInfo: { generationId: 'old-generation', model: 'old-model' },
                },
                {
                    chatId: 'newest-generation',
                    generationInfo: { generationId: 'newest-generation', model: 'new-model' },
                },
            ],
        } as Message

        expect(resolveRequestDiagnosticContext(message)).toMatchObject({
            requestKey: 'old-generation',
            time: 100,
            hasSwipeSet: true,
            generationInfo: { generationId: 'old-generation', model: 'old-model' },
        })
    })

    it('does not fall back to the newest request for a legacy swipe', () => {
        const message = {
            role: 'char',
            data: 'old answer',
            chatId: 'newest-generation',
            generationInfo: { generationId: 'newest-generation', model: 'new-model' },
            promptInfo: { promptName: 'new-preset' },
            swipes: ['old answer', 'new answer'],
            swipeId: 0,
        } as Message

        expect(resolveRequestDiagnosticContext(message, message.generationInfo)).toEqual({
            generationInfo: { generationId: 'newest-generation', model: 'new-model' },
            promptInfo: { promptName: 'new-preset' },
            swipeMetadata: undefined,
            requestKey: '',
            time: undefined,
            hasSwipeSet: true,
        })
    })
})

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

    it('does not apply newest message diagnostics to an older legacy swipe', () => {
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
            generationInfo: {},
            promptInfo: undefined,
            swipeMetadata: undefined,
            requestKey: '',
            time: undefined,
            hasSwipeSet: true,
        })
    })

    it('uses message-level diagnostics for the newest legacy swipe only', () => {
        const message = {
            role: 'char',
            data: 'new answer',
            chatId: 'newest-generation',
            time: 200,
            generationInfo: { generationId: 'newest-generation', model: 'new-model' },
            promptInfo: { promptName: 'new-preset' },
            swipes: ['old answer', 'new answer'],
            swipeId: 1,
        } as Message

        expect(resolveRequestDiagnosticContext(message)).toEqual({
            generationInfo: { generationId: 'newest-generation', model: 'new-model' },
            promptInfo: { promptName: 'new-preset' },
            swipeMetadata: undefined,
            requestKey: '',
            time: 200,
            hasSwipeSet: true,
        })
    })

    it('does not apply newest diagnostics to an empty swipe metadata entry', () => {
        const message = {
            role: 'char',
            data: 'old answer',
            chatId: 'newest-generation',
            time: 300,
            generationInfo: {
                generationId: 'newest-generation',
                inputTokens: 2_000,
                stageTiming: { stage3: 5_000 },
            },
            promptInfo: { promptName: 'newest-preset' },
            swipes: ['old answer', 'new answer'],
            swipeId: 0,
            swipeMetadata: [{}, {
                chatId: 'newest-generation',
                generationInfo: { generationId: 'newest-generation' },
            }],
        } as Message

        expect(resolveRequestDiagnosticContext(message)).toEqual({
            generationInfo: {},
            promptInfo: undefined,
            swipeMetadata: {},
            requestKey: '',
            time: undefined,
            hasSwipeSet: true,
        })
    })

    it('does not substitute the last metadata entry for a missing index', () => {
        const message = {
            role: 'char',
            data: 'third answer',
            generationInfo: { generationId: 'generation-3' },
            swipes: ['first answer', 'second answer', 'third answer'],
            swipeId: 2,
            swipeMetadata: [
                { chatId: 'generation-1' },
                { chatId: 'generation-2' },
            ],
        } as Message

        expect(resolveRequestDiagnosticContext(message)).toEqual({
            generationInfo: {},
            promptInfo: undefined,
            swipeMetadata: undefined,
            requestKey: '',
            time: undefined,
            hasSwipeSet: true,
        })
    })

    it('uses the selected swipe timings without a message-level override', () => {
        const message = {
            role: 'char',
            data: 'new answer',
            chatId: 'generation-2',
            generationInfo: {
                generationId: 'generation-2',
                stageTiming: { stage1: 100, stage2: 0, stage3: 2500, stage4: 80 },
            },
            swipes: ['old answer', 'new answer'],
            swipeId: 1,
            swipeMetadata: [
                { chatId: 'generation-1', generationInfo: { generationId: 'generation-1' } },
                {
                    chatId: 'generation-2',
                    generationInfo: {
                        generationId: 'generation-2',
                        stageTiming: { stage1: 100, stage2: 0, stage3: 2500, stage4: 80 },
                    },
                },
            ],
        } as Message

        expect(resolveRequestDiagnosticContext(message).generationInfo.stageTiming).toEqual({
            stage1: 100,
            stage2: 0,
            stage3: 2500,
            stage4: 80,
        })
    })
})

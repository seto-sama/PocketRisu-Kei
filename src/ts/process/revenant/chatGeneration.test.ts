import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    awaitCanonical: vi.fn(),
    endProjection: vi.fn(),
    cancel: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    updateStep: vi.fn(async () => {}),
}))

vi.mock('../../storage/chatWorkingCopy', () => ({
    awaitChatGenerationCanonical: mocks.awaitCanonical,
    endChatGenerationProjection: mocks.endProjection,
}))
vi.mock('../../storage/chatStorage', () => ({
    createChatCommitSnapshot: (characterId: string, chat: any) => ({
        characterId,
        chatId: chat.id,
        chat: structuredClone(chat),
        expectedEtag: 'base-etag',
    }),
}))
vi.mock('./workflow', () => ({
    cancelRevenantWorkflow: mocks.cancel,
    finishRevenantWorkflow: mocks.finish,
    updateRevenantWorkflowStep: mocks.updateStep,
}))

import {
    applyCancelledRerollSession,
    createChatGenerationSession,
    findGenerationTargetMessageIndex,
    isGenerationOwnedMessage,
    prepareChatReroll,
    shouldRetainRerollProjectionForCanonical,
} from './chatGeneration'

beforeEach(() => vi.clearAllMocks())

describe('chat generation session', () => {
    it('owns workflow step updates and terminal handoff', async () => {
        const session = createChatGenerationSession(
            { characterId: 'character-1', roomId: 'room-1' },
            'workflow-1',
        )

        await session.setStep('model.main', 'running')
        await session.finish('cancelled')

        expect(mocks.updateStep).toHaveBeenCalledWith(
            'workflow-1', 'model.main', 'running', undefined,
        )
        expect(mocks.awaitCanonical).toHaveBeenCalledWith('character-1', 'room-1')
        expect(mocks.cancel).toHaveBeenCalledWith('workflow-1')
        expect(session.workflowId).toBeUndefined()
    })
})

describe('generation message ownership', () => {
    it('selects and locks only the generation-owned character response', () => {
        const messages = [
            { role: 'user', data: 'question' },
            { role: 'char', data: 'answer' },
            { role: 'user', data: 'comment', isComment: true },
        ] as any
        const targetIndex = findGenerationTargetMessageIndex(messages)

        expect(targetIndex).toBe(1)
        expect(isGenerationOwnedMessage({
            message: messages[1],
            messageIndex: 1,
            generationTargetIndex: targetIndex,
            roomIsResponding: true,
        })).toBe(true)
        expect(isGenerationOwnedMessage({
            message: messages[0],
            messageIndex: 0,
            generationTargetIndex: targetIndex,
            roomIsResponding: true,
        })).toBe(false)
    })

    it('keeps recovery-owned messages locked independently of room activity', () => {
        expect(isGenerationOwnedMessage({
            message: { role: 'char', data: '', isRecovering: true } as any,
            messageIndex: 0,
            generationTargetIndex: -1,
            roomIsResponding: false,
        })).toBe(true)
    })
})

describe('chat reroll preparation', () => {
    it('keeps a server-owned cancelled placeholder until canonical handoff', () => {
        expect(shouldRetainRerollProjectionForCanonical({
            abortRequested: true,
            workflowId: 'workflow-1',
        })).toBe(true)
        expect(shouldRetainRerollProjectionForCanonical({
            abortRequested: true,
        })).toBe(false)
        expect(shouldRetainRerollProjectionForCanonical({
            abortRequested: false,
            workflowId: 'workflow-1',
        })).toBe(false)
    })

    it('captures the durable full chat before trimming the generation branch', () => {
        const chat = {
            id: 'room-1',
            message: [
                { role: 'user', data: 'question', chatId: 'user-1' },
                { role: 'char', data: 'answer', chatId: 'answer-1', swipes: ['old', 'answer'] },
                { role: 'user', data: 'comment', chatId: 'comment-1', isComment: true },
            ],
        } as any

        const prepared = prepareChatReroll('character-1', chat)

        expect(prepared?.durableInputCommit.chat).toEqual(chat)
        expect(prepared?.durableInputCommit.expectedEtag).toBe('base-etag')
        expect(prepared?.generationMessages).toEqual([
            { role: 'user', data: 'question', chatId: 'user-1' },
        ])
        expect(prepared?.rerollSnapshot).toMatchObject({
            targetIndex: 1,
            targetMessage: { chatId: 'answer-1' },
            trailingMessages: [{ chatId: 'comment-1' }],
        })
    })

    it('promotes a cancelled partial into a swipe and restores trailing messages', () => {
        const character = { reloadKeys: 0 } as any
        const chat = {
            id: 'room-1',
            isStreaming: true,
            message: [
                { role: 'user', data: 'question', chatId: 'user-1' },
                { role: 'char', data: 'partial', chatId: 'generated-1' },
            ],
        } as any

        expect(applyCancelledRerollSession(character, chat, {
            originalTargetChatId: 'answer-1',
            savedSwipes: ['old answer'],
            generatedMessageIndex: 1,
            trailingMessages: [{ role: 'user', data: 'comment', isComment: true } as any],
        })).toBe(true)
        expect(chat.message[1]).toMatchObject({
            data: 'partial',
            swipes: ['old answer', 'partial'],
            swipeId: 1,
        })
        expect(chat.message[2]).toMatchObject({ isComment: true })
        expect(chat.isStreaming).toBe(false)
        expect(character.reloadKeys).toBe(1)
    })
})

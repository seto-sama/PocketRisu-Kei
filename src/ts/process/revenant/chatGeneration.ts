import { safeStructuredClone } from '../../polyfill'
import type { character, Chat, Message } from '../../storage/database.svelte'
import { createChatCommitSnapshot } from '../../storage/chatStorage'
import {
    awaitChatGenerationCanonical,
    endChatGenerationProjection,
    type ChatCommitSnapshot,
} from '../../storage/chatWorkingCopy'
import type { RevenantRerollSnapshot, RevenantWorkflowStepStatus } from './types'
import {
    cancelRevenantWorkflow,
    finishRevenantWorkflow,
    updateRevenantWorkflowStep,
} from './workflow'

export type ChatGenerationTarget = {
    characterId: string
    roomId: string
}

/** Owns the workflow id and its command-side terminal transition. */
export function createChatGenerationSession(
    target: ChatGenerationTarget,
    initialWorkflowId?: string,
) {
    let workflowId = initialWorkflowId

    return {
        get workflowId() {
            return workflowId
        },
        adopt(nextWorkflowId: string) {
            workflowId = nextWorkflowId
        },
        clear() {
            workflowId = undefined
        },
        async setStep(
            stepKey: string,
            status: RevenantWorkflowStepStatus,
            metadata?: Record<string, unknown>,
        ) {
            if (!workflowId) return
            try {
                await updateRevenantWorkflowStep(workflowId, stepKey, status, metadata)
            } catch (error) {
                console.error(`[GenerationWorkflow] Failed to update ${stepKey} to ${status}:`, error)
            }
        },
        async finish(status: 'completed' | 'cancelled' | 'failed') {
            if (!workflowId) return
            const terminalWorkflowId = workflowId
            if (status !== 'completed') {
                awaitChatGenerationCanonical(target.characterId, target.roomId)
            }
            try {
                if (status === 'cancelled') await cancelRevenantWorkflow(terminalWorkflowId)
                else await finishRevenantWorkflow(terminalWorkflowId, status)
                workflowId = undefined
                if (status === 'completed') {
                    endChatGenerationProjection(target.characterId, target.roomId)
                }
            } catch (error) {
                console.error(
                    `[GenerationWorkflow] Failed to finish ${terminalWorkflowId}:`,
                    error,
                )
            }
        },
    }
}

export type ChatGenerationSession = ReturnType<typeof createChatGenerationSession>

export function findGenerationTargetMessageIndex(messages: Message[]) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (!message.isComment && !message.disabled) {
            return message.role === 'char' ? index : -1
        }
    }
    return -1
}

/** UI controls are locked only for the message range owned by generation. */
export function isGenerationOwnedMessage(input: {
    message: Message
    messageIndex: number
    generationTargetIndex: number
    roomIsResponding: boolean
}) {
    return input.message.role === 'char'
        && (
            input.message.isRecovering === true
            || (
                input.roomIsResponding
                && input.messageIndex === input.generationTargetIndex
            )
        )
}

export type ActiveRerollSession = {
    originalTargetChatId?: string
    savedSwipes: string[]
    generatedMessageIndex: number
    trailingMessages: Message[]
}

export function shouldRetainRerollProjectionForCanonical(input: {
    abortRequested: boolean
    workflowId?: string
}) {
    return input.abortRequested && !!input.workflowId
}

export type PreparedChatReroll = {
    durableInputCommit: ChatCommitSnapshot
    originalMessages: Message[]
    generationMessages: Message[]
    rerollSnapshot: RevenantRerollSnapshot
    session: ActiveRerollSession
}

/** Prepare the durable base and temporary prompt branch as one operation. */
export function prepareChatReroll(
    characterId: string,
    chat: Chat,
): PreparedChatReroll | null {
    const durableInputCommit = createChatCommitSnapshot(characterId, chat)
    const originalMessages = safeStructuredClone(chat.message)
    const generationMessages = safeStructuredClone(chat.message)
    if (generationMessages.length === 0) return null

    const trailingMessages: Message[] = []
    while (
        generationMessages.length > 0
        && (generationMessages.at(-1)?.isComment || generationMessages.at(-1)?.disabled)
    ) {
        const trailing = generationMessages.pop()
        if (trailing) trailingMessages.unshift(trailing)
    }
    if (generationMessages.length === 0) return null

    const saying = generationMessages.at(-1)?.saying
    let sayingCount = 2
    while (generationMessages.at(-1)?.role !== 'user') {
        if (generationMessages.at(-1)?.saying === saying) {
            sayingCount -= 1
            if (sayingCount === 0) break
        }
        if (!generationMessages.pop()) return null
    }

    const generatedMessageIndex = generationMessages.length
    const targetMessage = originalMessages[generatedMessageIndex]
    if (!targetMessage) return null
    const savedSwipes = targetMessage.swipes
        ? [...targetMessage.swipes]
        : [targetMessage.data]
    const rerollSnapshot: RevenantRerollSnapshot = {
        targetMessage: safeStructuredClone(targetMessage),
        targetIndex: generatedMessageIndex,
        trailingMessages: safeStructuredClone(trailingMessages),
    }
    return {
        durableInputCommit,
        originalMessages,
        generationMessages,
        rerollSnapshot,
        session: {
            originalTargetChatId: targetMessage.chatId,
            savedSwipes,
            generatedMessageIndex,
            trailingMessages: safeStructuredClone(trailingMessages),
        },
    }
}

/** Promote a cancelled partial reroll into the swipe history. */
export function applyCancelledRerollSession(
    character: character,
    chat: Chat,
    session?: ActiveRerollSession,
) {
    if (!session) return false
    const generatedMessage = chat.message[session.generatedMessageIndex]
    const generatedData = generatedMessage?.role === 'char'
        ? generatedMessage.data ?? ''
        : ''
    if (
        !generatedMessage
        || generatedMessage.role !== 'char'
        || !generatedData.trim()
        || generatedMessage.chatId === session.originalTargetChatId
    ) return false

    generatedMessage.swipes = [...session.savedSwipes, generatedData]
    generatedMessage.swipeId = generatedMessage.swipes.length - 1
    generatedMessage.data = generatedData
    chat.message.splice(session.generatedMessageIndex + 1)
    if (session.trailingMessages.length > 0) {
        chat.message.push(...safeStructuredClone(session.trailingMessages))
    }
    chat.isStreaming = false
    character.reloadKeys += 1
    return true
}

import { safeStructuredClone } from '../../../polyfill'
import type { Chat, Message } from '../../../storage/database.svelte'
import type { RevenantRerollSnapshot } from '../types'
import { buildRerollSwipeMetadata } from './chatGenerationTarget'

export interface CancelledGenerationProjection {
    messageChatId: string
    content: string
    isContinuation: boolean
    targetMessage?: Message
    rerollSnapshot?: RevenantRerollSnapshot
}

function clearRecoveryDisplay(message: Message): void {
    delete message.isRecovering
    delete message.recoveryDisplayData
}

/**
 * Promotes the response displayed by detached recovery into the compatible
 * chat when the user cancels. Cancellation stops future generation; bytes
 * already received remain visible just like a locally cancelled stream.
 */
export function applyCancelledGenerationProjection(
    chat: Chat,
    projection: CancelledGenerationProjection,
): void {
    const content = projection.content
    const snapshot = projection.rerollSnapshot
    const target = projection.targetMessage
        ?? chat.message.find(message => message?.chatId === projection.messageChatId)

    if (!content.trim()) {
        if (snapshot) {
            chat.message.splice(
                snapshot.targetIndex,
                Math.max(0, chat.message.length - snapshot.targetIndex),
                safeStructuredClone(snapshot.targetMessage),
                ...safeStructuredClone(snapshot.trailingMessages),
            )
        }
        else if (!projection.isContinuation) {
            chat.message = chat.message.filter(message =>
                message !== target && message?.chatId !== projection.messageChatId)
        }
        if (target) clearRecoveryDisplay(target)
        chat.isStreaming = false
        return
    }

    if (snapshot) {
        const previousSwipes = Array.isArray(snapshot.targetMessage.swipes)
            ? [...snapshot.targetMessage.swipes]
            : [snapshot.targetMessage.data]
        const committed: Message = {
            ...safeStructuredClone(snapshot.targetMessage),
            ...(target ? {
                saying: target.saying,
                time: target.time,
                generationInfo: target.generationInfo,
                promptInfo: target.promptInfo,
            } : {}),
            role: 'char',
            data: content,
            chatId: projection.messageChatId,
            swipes: [...previousSwipes, content],
            swipeId: previousSwipes.length,
            swipeMetadata: target?.swipeMetadata
                ? safeStructuredClone(target.swipeMetadata)
                : buildRerollSwipeMetadata(snapshot.targetMessage, {
                    chatId: projection.messageChatId,
                    time: target?.time,
                    generationInfo: target?.generationInfo,
                    promptInfo: target?.promptInfo,
                }),
        }
        clearRecoveryDisplay(committed)
        chat.message.splice(
            snapshot.targetIndex,
            Math.max(0, chat.message.length - snapshot.targetIndex),
            committed,
            ...safeStructuredClone(snapshot.trailingMessages),
        )
    }
    else if (target) {
        target.data = content
        target.chatId = projection.messageChatId
        clearRecoveryDisplay(target)
    }
    else {
        chat.message.push({
            role: 'char',
            data: content,
            chatId: projection.messageChatId,
        })
    }

    chat.isStreaming = false
}

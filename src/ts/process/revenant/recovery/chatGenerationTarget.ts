import { safeStructuredClone } from '../../../polyfill'
import type {
    Chat,
    Message,
    MessageGenerationInfo,
    MessagePresetInfo,
    MessageSwipeMetadata,
} from '../../../storage/database.svelte'
import type { RevenantRerollSnapshot } from '../types'

export interface GenerationMessageTargetOptions {
    messageChatId: string
    characterId: string
    isContinuation: boolean
    generationInfo?: MessageGenerationInfo
    promptInfo?: MessagePresetInfo
    rerollSnapshot?: RevenantRerollSnapshot
}

function metadataFromMessage(message: Message): MessageSwipeMetadata {
    return {
        chatId: message.chatId,
        time: message.time,
        generationInfo: message.generationInfo
            ? safeStructuredClone(message.generationInfo)
            : undefined,
        promptInfo: message.promptInfo
            ? safeStructuredClone(message.promptInfo)
            : undefined,
    }
}

/**
 * Builds the diagnostic metadata array that runs alongside a message's
 * regenerated response strings. In the legacy swipe format, message-level
 * diagnostics belong to the most recently generated (last) swipe; changing
 * swipeId only changed the displayed text.
 */
export function buildRerollSwipeMetadata(
    message: Message,
    next: MessageSwipeMetadata,
): MessageSwipeMetadata[] {
    const swipeCount = Array.isArray(message.swipes) ? message.swipes.length : 1
    const existing = Array.isArray(message.swipeMetadata)
        ? safeStructuredClone(message.swipeMetadata.slice(0, swipeCount))
        : []

    while (existing.length < swipeCount) existing.push({})

    if (!message.swipeMetadata) {
        existing[swipeCount - 1] = metadataFromMessage(message)
    }

    existing.push(safeStructuredClone(next))
    return existing
}

export function getActiveSwipeMetadata(message: Message): MessageSwipeMetadata | undefined {
    if (!Array.isArray(message.swipeMetadata) || message.swipeMetadata.length === 0) return undefined
    const index = Array.isArray(message.swipes)
        ? message.swipeId ?? 0
        : 0
    if (index < 0 || index >= message.swipeMetadata.length) return undefined
    return message.swipeMetadata[index]
}

/**
 * Updates a generated message without losing reroll swipe state. Reroll
 * placeholders keep the in-progress branch in their selected swipe, so every
 * streamed/non-streamed content update must update both views atomically.
 */
export function setGenerationMessageContent(message: Message, content: string): void {
    message.data = content
    if (
        Array.isArray(message.swipes)
        && Number.isInteger(message.swipeId)
        && (message.swipeId as number) >= 0
        && (message.swipeId as number) < message.swipes.length
    ) {
        message.swipes[message.swipeId as number] = content
    }
}

/** Keeps completed diagnostics identical on the message and selected swipe. */
export function setGenerationMessageInfo(
    message: Message,
    generationInfo: MessageGenerationInfo,
): void {
    message.generationInfo = generationInfo
    const metadata = getActiveSwipeMetadata(message)
    if(metadata) metadata.generationInfo = safeStructuredClone(generationInfo)
}

/**
 * Finds the transient assistant message by its stable id. A remote chat refresh
 * can replace the entire message array while generation is in progress, so a
 * numeric index captured before an await/stream read is never safe to reuse.
 *
 * When the refresh came from a device that had not seen the placeholder yet,
 * rebuild the same transient shape instead of dropping streamed output.
 */
export function ensureGenerationMessageTarget(
    chat: Chat,
    options: GenerationMessageTargetOptions,
): { message: Message, index: number } {
    const existingIndex = chat.message.findIndex(message =>
        message?.chatId === options.messageChatId)
    if(existingIndex >= 0){
        return { message: chat.message[existingIndex], index: existingIndex }
    }

    if(options.isContinuation){
        for(let index = chat.message.length - 1; index >= 0; index--){
            const message = chat.message[index]
            if(message?.role !== 'char') continue
            Object.assign(message, {
                chatId: options.messageChatId,
                generationInfo: options.generationInfo,
                promptInfo: options.promptInfo,
            })
            return { message, index }
        }
        throw new Error('Cannot continue generation without an assistant message')
    }

    let placeholder: Message
    let insertIndex = chat.message.length
    if(options.rerollSnapshot){
        const snapshot = options.rerollSnapshot
        const target = snapshot.targetMessage
        const previousSwipes = Array.isArray(target.swipes)
            ? [...target.swipes]
            : [target.data]
        placeholder = {
            ...safeStructuredClone(target),
            role: 'char',
            data: '',
            saying: options.characterId,
            time: Date.now(),
            chatId: options.messageChatId,
            generationInfo: options.generationInfo,
            promptInfo: options.promptInfo,
            swipes: [...previousSwipes, ''],
            swipeId: previousSwipes.length,
            swipeMetadata: buildRerollSwipeMetadata(target, {
                chatId: options.messageChatId,
                time: Date.now(),
                generationInfo: options.generationInfo,
                promptInfo: options.promptInfo,
            }),
        }
        insertIndex = Math.min(
            Math.max(0, snapshot.targetIndex),
            chat.message.length,
        )
        chat.message.splice(
            insertIndex,
            Math.max(0, chat.message.length - insertIndex),
            placeholder,
        )
    }
    else{
        placeholder = {
            role: 'char',
            data: '',
            saying: options.characterId,
            time: Date.now(),
            generationInfo: options.generationInfo,
            promptInfo: options.promptInfo,
            chatId: options.messageChatId,
        }
        chat.message.push(placeholder)
    }

    return { message: placeholder, index: insertIndex }
}

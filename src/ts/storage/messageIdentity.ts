import { createEntityId } from '../id';
import type { Message } from './database.svelte';
import { getActiveSwipeMetadata } from '../process/revenant/recovery/chatGenerationTarget';

/** Memory follows the room's message; provider context follows the selected response. */
export function getMessagePromptIdentity(message: Message) {
    return {
        memo: message.chatId,
        responseId: getActiveSwipeMetadata(message)?.chatId ?? message.chatId,
    }
}

/** Assign a stable identity when a message crosses into chat storage. */
export function ensureMessageId<T extends object>(message: T): T & { chatId: string } {
    const identified = message as T & { chatId?: string }
    if (!identified.chatId) identified.chatId = createEntityId()
    return identified as T & { chatId: string }
}

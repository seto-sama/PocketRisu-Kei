import { createEntityId } from 'src/ts/id';

/** Assign a stable identity when a message crosses into chat storage. */
export function ensureMessageId<T extends object>(message: T): T & { chatId: string } {
    const identified = message as T & { chatId?: string }
    if (!identified.chatId) identified.chatId = createEntityId()
    return identified as T & { chatId: string }
}

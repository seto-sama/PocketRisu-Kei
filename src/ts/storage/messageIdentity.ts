import { v4 as uuidv4 } from 'uuid'

/** Assign a stable identity when a message crosses into chat storage. */
export function ensureMessageId<T extends object>(message: T): T & { chatId: string } {
    const identified = message as T & { chatId?: string }
    if (!identified.chatId) identified.chatId = uuidv4()
    return identified as T & { chatId: string }
}

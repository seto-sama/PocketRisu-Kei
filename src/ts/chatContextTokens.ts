import type { Chat, Message } from './storage/database.svelte'

interface ChatTokenCounter {
    tokenizeChat(message: {
        role: 'system' | 'user' | 'assistant';
        content: string;
    }): Promise<number>
}

export interface TokenizableChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export function selectActiveChatMessages(chat: Chat, limit = Number.POSITIVE_INFINITY): {
    messages: Message[];
    startsAfterCutoff: boolean;
} {
    const messages: Message[] = []
    let startsAfterCutoff = false
    const maxMessages = Math.max(0, limit)
    if (maxMessages === 0) return { messages, startsAfterCutoff }
    for (let index = chat.message.length - 1; index >= 0; index--) {
        const message = chat.message[index]
        if (message.kind === 'imageGeneration' || message.isRecovering || message.disabled === true) {
            continue
        }
        if (message.disabled === 'allBefore') {
            startsAfterCutoff = true
            break
        }
        messages.push(message)
        if (messages.length >= maxMessages) break
    }
    messages.reverse()
    return { messages, startsAfterCutoff }
}

export async function getRecentChatToken(
    chat: Chat,
    count: number,
    tokenizer: ChatTokenCounter,
    renderMessage: (message: Message) => string | Promise<string> = message => message.data,
): Promise<number> {
    const recentMessages = selectActiveChatMessages(chat, count).messages
    const messages = await Promise.all(recentMessages.map(async message => ({
        role: message.role === 'user' ? 'user' as const : 'assistant' as const,
        content: await renderMessage(message),
    })))
    return getRecentContextToken(messages, messages.length, tokenizer)
}

export async function getRecentContextToken(
    messages: TokenizableChatMessage[],
    count: number,
    tokenizer: ChatTokenCounter,
): Promise<number> {
    if (count <= 0) return 0
    const recentMessages = messages.slice(-Math.max(0, count))
    let tokens = 0
    for (const message of recentMessages) {
        tokens += await tokenizer.tokenizeChat(message)
    }
    return tokens
}

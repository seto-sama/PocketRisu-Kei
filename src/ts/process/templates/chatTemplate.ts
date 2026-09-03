import type { OpenAIChat } from '../index.svelte'

export function formatChatML(messages: OpenAIChat[]): string {
    const formatted = messages
        .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
        .map((message) => `<|im_start|>${message.role}\n${message.content}<|im_end|>\n`)
        .join('')

    return `${formatted}<|im_start|>assistant\n`
}

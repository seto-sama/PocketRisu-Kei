import { describe, expect, it, vi } from 'vitest'
import { getRecentChatToken, getRecentContextToken, selectActiveChatMessages } from './chatContextTokens'

function chatWith(message: any[]) {
    return { message } as any
}

describe('chat context token selection', () => {
    it('matches generation filtering and cutoff behavior', () => {
        const cutoff = { role: 'user', data: 'cutoff', disabled: 'allBefore' }
        const keptUser = { role: 'user', data: 'hello' }
        const keptAssistant = { role: 'char', data: 'world' }
        const selected = selectActiveChatMessages(chatWith([
            { role: 'user', data: 'old' },
            cutoff,
            { role: 'char', data: 'disabled', disabled: true },
            { role: 'char', data: 'image', kind: 'imageGeneration' },
            { role: 'char', data: 'recovering', isRecovering: true },
            keptUser,
            keptAssistant,
        ]))

        expect(selected).toEqual({
            messages: [keptUser, keptAssistant],
            startsAfterCutoff: true,
        })
    })

    it('tokenizes only the configured number of most recent messages', async () => {
        const tokenizeChat = vi.fn(async ({ content }: { content: string }) => content.length + 1)
        const tokens = await getRecentChatToken(chatWith([
            { role: 'user', data: 'old' },
            { role: 'char', data: 'recent' },
            { role: 'user', data: 'last' },
        ]), 2, { tokenizeChat }, message => message.data.toUpperCase())

        expect(tokens).toBe(12)
        expect(tokenizeChat.mock.calls.map(([value]) => value)).toEqual([
            { role: 'assistant', content: 'RECENT' },
            { role: 'user', content: 'LAST' },
        ])
    })

    it('tokenizes every supplied context candidate in the recent window', async () => {
        const tokenizeChat = vi.fn(async ({ content }: { content: string }) => content.length)
        const tokens = await getRecentContextToken([
            { role: 'system', content: 'start' },
            { role: 'assistant', content: 'greeting' },
            { role: 'user', content: 'hello' },
        ], 3, { tokenizeChat })

        expect(tokens).toBe(18)
    })

    it('does no tokenization when the recent message count is zero', async () => {
        const tokenizeChat = vi.fn(async () => 1)
        const tokens = await getRecentContextToken([
            { role: 'user', content: 'ignored' },
        ], 0, { tokenizeChat })

        expect(tokens).toBe(0)
        expect(tokenizeChat).not.toHaveBeenCalled()
    })
})

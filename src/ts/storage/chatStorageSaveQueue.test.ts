import { describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => {
    let etag: string | undefined
    const releases: Array<() => void> = []
    const calls: Array<{ expectedEtag?: string, data: string }> = []
    return {
        calls,
        releases,
        realStorage: {
            saveChatContent: vi.fn(async (
                _characterId: string,
                _chatIndex: number,
                _chatId: string,
                chat: { message: Array<{ data: string }> },
                commit?: { expectedEtag?: string },
            ) => {
                calls.push({ expectedEtag: commit?.expectedEtag, data: chat.message[0]?.data })
                await new Promise<void>(resolve => releases.push(resolve))
                etag = `etag-${calls.length}`
            }),
            getChatEtag: vi.fn(() => etag),
        },
    }
})

vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: storage.realStorage } }))
vi.mock('./database.svelte', () => ({ isChatStub: () => false }))

const { saveChatToServer } = await import('./chatStorage')

describe('chat save serialization', () => {
    it('queues an immediate follow-up edit until creation acknowledges its ETag', async () => {
        const chat = {
            id: 'copy',
            name: 'Copy',
            message: [{ role: 'user', data: 'before' }],
        } as any

        const creation = saveChatToServer('character', 0, chat.id, chat)
        await vi.waitFor(() => expect(storage.calls).toHaveLength(1))

        chat.message[0].data = 'after'
        const edit = saveChatToServer('character', 0, chat.id, chat)
        expect(storage.calls).toHaveLength(1)

        storage.releases.shift()?.()
        await creation
        await vi.waitFor(() => expect(storage.calls).toHaveLength(2))
        expect(storage.calls[1]).toEqual({ expectedEtag: 'etag-1', data: 'after' })

        storage.releases.shift()?.()
        await edit
    })
})

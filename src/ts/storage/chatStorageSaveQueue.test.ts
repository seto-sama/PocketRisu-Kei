import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDelta } from '../../../shared/guardedDelta.mjs'

const storage = vi.hoisted(() => {
    let etag: string | undefined
    let savedChat: any
    const releases: Array<() => void> = []
    const calls: Array<{ data: string }> = []
    return {
        calls,
        releases,
        reset() {
            calls.length = 0
            releases.length = 0
            etag = undefined
            savedChat = undefined
        },
        realStorage: {
            patchChatContent: vi.fn(async (
                _characterId: string,
                _chatIndex: number,
                _chatId: string,
                request: { changes: any[] },
            ) => {
                const next = applyDelta(savedChat, request.changes)
                calls.push({ data: next.message[0]?.data })
                await new Promise<void>(resolve => releases.push(resolve))
                savedChat = next
                etag = `etag-${calls.length}`
                return { etag }
            }),
            getChatEtag: vi.fn(() => etag),
        },
    }
})

vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: storage.realStorage } }))
vi.mock('./database.svelte', () => ({ isChatStub: () => false }))

const { flushDirtyChatToServer, saveChatToServer } = await import('./chatStorage')
const {
    discardAllChatWorkingCopies,
    isChatWorkingCopyDirty,
    markChatWorkingCopyDirty,
} = await import('./chatWorkingCopy')

beforeEach(() => {
    storage.reset()
    discardAllChatWorkingCopies()
})

describe('chat save serialization', () => {
    it('queues an immediate follow-up edit until creation acknowledges its baseline', async () => {
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
        expect(storage.calls[1]).toEqual({ data: 'after' })

        storage.releases.shift()?.()
        await edit
    })

    it('settles a dirty edit before reroll can install its live projection', async () => {
        const chat = {
            id: 'room',
            message: [{ role: 'char', data: 'edited answer' }],
        } as any
        markChatWorkingCopyDirty('character', chat.id, 'base-etag')

        const flush = flushDirtyChatToServer('character', 0, chat)
        await vi.waitFor(() => expect(storage.calls).toEqual([
            { data: 'edited answer' },
        ]))
        storage.releases.shift()?.()

        await expect(flush).resolves.toBe(true)
        expect(isChatWorkingCopyDirty('character', chat.id)).toBe(false)

        chat.isStreaming = true
        chat.message[0].data = ''
        await expect(flushDirtyChatToServer('character', 0, chat)).resolves.toBe(false)
        expect(storage.calls).toHaveLength(1)
    })
})

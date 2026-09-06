import { beforeEach, expect, it, vi } from 'vitest'
import { scanDatabaseContent } from './scanDatabaseContent'

const { database, scanServer } = vi.hoisted(() => ({
    database: { characters: [] as any[] }, scanServer: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ getDatabase: () => database }))
vi.mock('./autoStorage', () => ({ forageStorage: { Init: vi.fn(), realStorage: { scanContentReferences: scanServer } } }))
beforeEach(() => { database.characters = []; scanServer.mockReset() })

it('protects server changes even when a loaded chat is stale, and retains local unsaved references', async () => {
    const placeholder = { id: 'unopened', _placeholder: true, message: [] }
    database.characters = [{ firstMessage: '{{inlay::greeting}}', alternateGreetings: ['{{inlay::alternate}}'], chats: [
        { id: 'loaded', message: [{ data: '{{inlay::local}}', swipes: ['{{inlay::swipe}}'] }] }, placeholder,
    ] }]
    scanServer.mockResolvedValue({ kind: 'inlay', scannedAt: 1, totalMessages: 2, refCounts: { addedByOtherDevice: 1, unopened: 1 } })
    expect((await scanDatabaseContent('inlay', ['addedByOtherDevice', 'unopened'])).refCounts).toEqual({ addedByOtherDevice: 1, unopened: 1, greeting: 1, alternate: 1, local: 1, swipe: 1 })
    expect(scanServer).toHaveBeenCalledExactlyOnceWith('inlay', ['addedByOtherDevice', 'unopened'])
    expect(placeholder.message).toEqual([])
})

it('uses the same server/local union for translation cleanup, excluding comments and deduplicating texts', async () => {
    database.characters = [{ firstMessage: 'greeting', chats: [{ message: [
        { data: 'local edit', swipes: ['alternate'] }, { data: 'comment', isComment: true, swipes: ['comment swipe'] },
    ], hypaV3Data: { summaries: [{ text: 'summary' }] } }] }]
    scanServer.mockResolvedValue({ kind: 'translation', scannedAt: 1, totalMessages: 3, keys: ['server changed message', 'server-only chat', 'greeting'] })
    expect(new Set((await scanDatabaseContent('translation', ['server changed message', 'server-only chat', 'greeting'])).keys)).toEqual(new Set(['server changed message', 'server-only chat', 'greeting', 'local edit', 'alternate', 'summary']))
})

it.each(['inlay', 'translation'] as const)('aborts %s cleanup when the server is unavailable', async kind => {
    scanServer.mockRejectedValue(new Error('offline'))
    await expect(scanDatabaseContent(kind, ['known'])).rejects.toThrow('offline')
})

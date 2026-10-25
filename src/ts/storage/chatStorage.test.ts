import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest'
import { get } from 'svelte/store'

const storageMocks = vi.hoisted(() => ({ fetchChatState: vi.fn() }))

// Stub out the heavy reactive modules so loading chatStorage.ts doesn't trigger
// unrelated $effect chains that fail in a stripped-down test environment.
// Mirror the production isChatStub semantics including the hybrid guard so
// the chat-data-loss tests below exercise the real intent.
vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: storageMocks } }))
vi.mock('./database.svelte', () => ({
    isChatStub: (chat: any) => chat
        && chat._stub === true
        && !Array.isArray(chat.message),
}))

const {
    chatToStub,
    stubToPlaceholder,
    convertStubsToPlaceholders,
    mergeHydratedChatWithMetadata,
    ensureChatHydrated,
    chatHydrationFailures,
    chatHydrationKey,
} = await import('./chatStorage')
type Chat = any
type ChatStub = any

// Round-trip tests for stub ↔ placeholder conversions. The server merge layer
// relies on key presence ('in' semantics) to distinguish "user cleared this
// field" from "field is absent". Both client converters must preserve key
// presence end-to-end, otherwise null clears get dropped on the way out and
// stale fullChat metadata resurfaces on the next persist.

const blankChat = (overrides: Partial<Chat> = {}): Chat => ({
    message: [],
    note: '',
    name: 'test',
    localLore: [],
    id: 'c1',
    ...overrides,
})

beforeEach(() => {
    storageMocks.fetchChatState.mockReset()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0)
        return 1
    })
})

afterEach(() => vi.unstubAllGlobals())

describe('chatToStub', () => {
    test('restores a hydrated body without reverting merged metadata or deleted fields', () => {
        const local = blankChat({
            name: 'Old name', folderId: 'old-folder', modules: ['old-module'],
            message: [{ chatId: 'm1', role: 'user', data: 'Local body' }],
        })
        const merged = mergeHydratedChatWithMetadata(local, {
            id: local.id, name: 'Server rename', folderId: null, _stub: true,
        })
        expect(merged.message).toEqual(local.message)
        expect(merged.name).toBe('Server rename')
        expect(merged.folderId).toBeNull()
        expect(merged).not.toHaveProperty('modules')
        expect(merged).not.toHaveProperty('_stub')
        expect(merged).not.toHaveProperty('_placeholder')
        expect(local.modules).toEqual(['old-module'])
    })

    test('same key-presence semantics applies to lastDate', () => {
        expect('lastDate' in chatToStub(blankChat({ lastDate: null as any }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat({ lastDate: 0 }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat())).toBe(false)
    })

    test('returns input untouched when already a stub', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        expect(chatToStub(stub)).toBe(stub)
    })
})

describe('stubToPlaceholder', () => {
    test('marks placeholder for hydration', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect(placeholder._placeholder).toBe(true)
        expect(placeholder.fmIndex).toBe(-1)
        expect(placeholder.message).toEqual([])
    })

})

describe('chat body hydration failures', () => {
    const failureFor = (chatId = 'c1') =>
        get(chatHydrationFailures).get(chatHydrationKey('character-1', chatId))

    test('records a missing body on 404 without replacing the placeholder', async () => {
        const placeholder = stubToPlaceholder({ id: 'c1', name: 't', _stub: true })
        const chats = [placeholder]
        storageMocks.fetchChatState.mockResolvedValue(null)

        await expect(ensureChatHydrated({ chaId: 'character-1', chats }, 0)).resolves.toBeNull()

        expect(chats[0]).toBe(placeholder)
        expect(chats[0]._placeholder).toBe(true)
        expect(failureFor()).toBe('missing')
    })

    test('records a request error, rethrows it, and preserves the placeholder', async () => {
        const placeholder = stubToPlaceholder({ id: 'c1', name: 't', _stub: true })
        const chats = [placeholder]
        const error = new Error('network unavailable')
        storageMocks.fetchChatState.mockRejectedValue(error)

        await expect(ensureChatHydrated({ chaId: 'character-1', chats }, 0)).rejects.toBe(error)

        expect(chats[0]).toBe(placeholder)
        expect(chats[0]._placeholder).toBe(true)
        expect(failureFor()).toBe('error')
    })

    test('clears failure when retry begins and removes it after successful hydration', async () => {
        const placeholder = stubToPlaceholder({ id: 'c1', name: 't', _stub: true })
        const chats = [placeholder]
        storageMocks.fetchChatState.mockResolvedValueOnce(null)
        await ensureChatHydrated({ chaId: 'character-1', chats }, 0)
        expect(failureFor()).toBe('missing')

        let resolveFetch!: (chat: Chat) => void
        storageMocks.fetchChatState.mockImplementationOnce(() => new Promise(resolve => {
            resolveFetch = chat => resolve({ chat })
        }))
        const hydrated = blankChat({ id: 'c1', message: [{ role: 'user', data: 'hello' }] })
        const retry = ensureChatHydrated({ chaId: 'character-1', chats }, 0)

        expect(failureFor()).toBeUndefined()
        await vi.waitFor(() => expect(resolveFetch).toBeDefined())
        resolveFetch(hydrated)
        await expect(retry).resolves.toBe(hydrated)
        expect(chats[0]).toBe(hydrated)
        expect(failureFor()).toBeUndefined()
    })

    test('deduplicates concurrent requests for the same placeholder', async () => {
        const chats = [stubToPlaceholder({ id: 'c1', name: 't', _stub: true })]
        let resolveFetch!: (chat: Chat) => void
        storageMocks.fetchChatState.mockImplementationOnce(() => new Promise(resolve => {
            resolveFetch = chat => resolve({ chat })
        }))
        const hydrated = blankChat({ id: 'c1', message: [{ role: 'user', data: 'hello' }] })

        const first = ensureChatHydrated({ chaId: 'character-1', chats }, 0)
        const second = ensureChatHydrated({ chaId: 'character-1', chats }, 0)
        await vi.waitFor(() => expect(storageMocks.fetchChatState).toHaveBeenCalledTimes(1))
        resolveFetch(hydrated)
        await expect(Promise.all([first, second])).resolves.toEqual([hydrated, hydrated])
    })

    test('applies the body to the live array when the chats array is replaced mid-fetch', async () => {
        const owner = { chaId: 'character-1', chats: [
            stubToPlaceholder({ id: 'c1', name: 't', _stub: true }),
            stubToPlaceholder({ id: 'c2', name: 'deleted', _stub: true }),
        ] }
        let resolveFetch!: (chat: Chat) => void
        storageMocks.fetchChatState.mockImplementationOnce(() => new Promise(resolve => {
            resolveFetch = chat => resolve({ chat })
        }))
        const hydrated = blankChat({ id: 'c1', message: [{ role: 'user', data: 'hello' }] })

        const pending = ensureChatHydrated(owner, 0)
        owner.chats = owner.chats.filter(chat => chat.id !== 'c2')
        await vi.waitFor(() => expect(resolveFetch).toBeDefined())
        resolveFetch(hydrated)

        await expect(pending).resolves.toBe(hydrated)
        expect(owner.chats[0]).toBe(hydrated)
    })
})

// Explicit null metadata must survive placeholder and stub conversion so the
// server receives a value change rather than a field removal.
describe('chat → stub → placeholder → stub round-trip', () => {
    test('null folderId survives the full round-trip', () => {
        const original = blankChat({ folderId: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(true)
        expect(stub2.folderId).toBeNull()
    })

    test('null modules survives the full round-trip', () => {
        const original = blankChat({ modules: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('modules' in stub2).toBe(true)
        expect(stub2.modules).toBeNull()
    })

    test('absent folderId stays absent through the round-trip', () => {
        const original = blankChat()
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(false)
    })

    test('non-null folderId survives the round-trip unchanged', () => {
        const original = blankChat({ folderId: 'F1' })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect(stub2.folderId).toBe('F1')
    })
})

// Hybrid corruption: a chat with `_stub: true` AND a real message array.
// Came from v1.4.x disk corruption. The lazy-loading invariants assume
// `_stub: true` means "metadata only", so the hybrid leaks Chat fields into
// patcher diffs and trips the chat-data guard. The fix self-heals by
// excluding hybrids from isChatStub (so chatToStub strips them properly)
// and by stripping the corrupt _stub flag in convertStubsToPlaceholders
// (preserving the real message data instead of resetting to placeholder).
describe('hybrid corruption (chat with _stub:true + message)', () => {
    const hybridChat = (overrides: any = {}): any => ({
        message: [{ role: 'user', data: 'hello' }],
        note: 'old note',
        name: 'h',
        localLore: [{ key: 'k' }],
        id: 'c-hybrid',
        _stub: true,
        ...overrides,
    })

    test('chatToStub collapses hybrid down to a real stub (drops message)', () => {
        const result = chatToStub(hybridChat()) as any
        expect(result._stub).toBe(true)
        expect('message' in result).toBe(false)
        expect('note' in result).toBe(false)
        expect('localLore' in result).toBe(false)
        expect(result.id).toBe('c-hybrid')
        expect(result.name).toBe('h')
    })

    test('convertStubsToPlaceholders keeps hybrid as a Chat with message preserved', () => {
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        // _stub flag must be gone — leaving it would re-enter the hybrid loop.
        expect((recovered as any)._stub).toBeUndefined()
        // Original message must survive — converting to a placeholder would
        // reset it to [], which IS the data-loss bug we're guarding against.
        expect(Array.isArray(recovered.message)).toBe(true)
        expect(recovered.message.length).toBe(1)
        expect(recovered.message[0].data).toBe('hello')
        expect(recovered.note).toBe('old note')
        expect(recovered.localLore.length).toBe(1)
    })

    test('hybrid round-trip self-heals: convert → chatToStub → no message leakage', () => {
        // Simulate the actual v1.4.x bug path:
        //   disk → decoded chat is hybrid → convertStubsToPlaceholders → patcher diff
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        const stub = chatToStub(recovered) as any
        expect(stub._stub).toBe(true)
        expect('message' in stub).toBe(false)
        expect('note' in stub).toBe(false)
        // Once stripped, the chat-data guard would see no chat-internal field
        // ops in a baseline-vs-current diff between two of these stubs.
    })
})

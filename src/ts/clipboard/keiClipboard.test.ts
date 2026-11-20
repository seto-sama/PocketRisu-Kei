import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    fetchKeiClipboard: vi.fn(),
    addKeiClipboardEntry: vi.fn(),
    pinKeiClipboardEntry: vi.fn(),
    deleteKeiClipboardEntry: vi.fn(),
}))

vi.mock('../storage/autoStorage', () => ({ forageStorage: { realStorage: mocks } }))
vi.mock('../stores.svelte', () => ({ DBState: { db: { keiClipboard: true, hotkeys: [] } } }))
vi.mock('../alert', () => ({ notifyError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('src/lang', () => ({ language: {} }))

type Service = typeof import('./keiClipboard.svelte')

const entry = (id: string, text: string, createdAt = 1) => ({ id, text, createdAt, pinned: false })

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
}

function trustedPaste(osText: string) {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', osText)
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
    Object.defineProperty(event, 'isTrusted', { value: true })
    return event
}

let service: Service
let uninstall: () => void

beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    localStorage.clear()
    // happy-dom has no execCommand; refusing it exercises the setRangeText fallback.
    document.execCommand = vi.fn(() => false)
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    service = await import('./keiClipboard.svelte')
    uninstall = service.installKeiClipboard()
})

afterEach(() => {
    vi.useRealTimers()
    uninstall()
    document.body.replaceChildren()
})

describe('Kei clipboard', () => {
    it('keeps a re-copied entry on top when an older fetch resolves after it', async () => {
        mocks.fetchKeiClipboard.mockResolvedValueOnce({ entries: [entry('b', 'B', 2), entry('a', 'A', 1)] })
        await service.refreshKeiClipboard()

        const staleFetch = deferred<{ entries: ReturnType<typeof entry>[] }>()
        const stored = deferred<{ entries: ReturnType<typeof entry>[] }>()
        mocks.fetchKeiClipboard.mockReturnValueOnce(staleFetch.promise)
        mocks.addKeiClipboardEntry.mockReturnValue(stored.promise)

        const refresh = service.refreshKeiClipboard()
        service.addKeiClipboardText('A')
        staleFetch.resolve({ entries: [entry('b', 'B', 2), entry('a', 'A', 1)] })
        await refresh
        expect(service.keiClipboard.entries.map(item => item.text)).toEqual(['A', 'B'])

        stored.resolve({ entries: [entry('a', 'A', 3), entry('b', 'B', 2)] })
        await vi.waitFor(() => expect(service.keiClipboard.entries[0].id).toBe('a'))
    })

    it('pastes the newer of the Kei clipboard and the OS clipboard', async () => {
        const stored = deferred<{ entries: ReturnType<typeof entry>[] }>()
        mocks.addKeiClipboardEntry.mockReturnValue(stored.promise)
        const field = document.createElement('textarea')
        document.body.appendChild(field)
        field.focus()

        // Copied here after the OS text was copied elsewhere: the Kei entry wins.
        vi.setSystemTime(2_000)
        service.addKeiClipboardText('kei text')
        vi.setSystemTime(3_000)
        const keiPaste = trustedPaste('copied in another app')
        field.dispatchEvent(keiPaste)
        expect(keiPaste.defaultPrevented).toBe(true)
        expect(field.value).toBe('kei text')

        // The user leaves and copies something else. The server acknowledging the older
        // Kei copy meanwhile must not make it look newer, so the OS text wins.
        vi.setSystemTime(4_000)
        vi.spyOn(document, 'hasFocus').mockReturnValue(false)
        window.dispatchEvent(new Event('blur'))
        vi.setSystemTime(4_500)
        stored.resolve({ entries: [entry('a', 'kei text', 2_000)] })
        await vi.waitFor(() => expect(service.keiClipboard.entries[0].id).toBe('a'))
        vi.setSystemTime(5_000)
        const osPaste = trustedPaste('copied after leaving')
        field.dispatchEvent(osPaste)
        expect(osPaste.defaultPrevented).toBe(false)
    })

    it('restores the user setting after the privacy guard forced it on', async () => {
        const { DBState } = await import('../stores.svelte')
        const db = DBState.db
        db.keiClipboard = false

        service.enableKeiClipboardForPrivacyGuard()
        service.enableKeiClipboardForPrivacyGuard()
        expect(db).toMatchObject({ keiClipboard: true, keiClipboardBeforePrivacyGuard: false })

        expect(service.restoreKeiClipboardAfterPrivacyGuard()).toBe(true)
        expect(db.keiClipboard).toBe(false)
        expect(db).not.toHaveProperty('keiClipboardBeforePrivacyGuard')
    })
})

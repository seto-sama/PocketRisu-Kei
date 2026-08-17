import { describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))

const { NodeStorage } = await import('./nodeStorage')

describe('NodeStorage patch transport', () => {
    it('does not send an empty JSON Patch', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn()
        ;(storage as any).authFetch = authFetch

        await expect(storage.patchItem('database/database.bin', {
            patch: [],
            expectedHash: 'stale-hash',
        })).resolves.toEqual({ success: true })
        expect(authFetch).not.toHaveBeenCalled()
    })
})

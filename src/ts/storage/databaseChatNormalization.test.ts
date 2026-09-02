import { describe, expect, it, vi } from 'vitest'

vi.mock('../stores.svelte', () => ({
    DBState: { db: {} as any },
    selectedCharID: { subscribe: () => () => {} },
    selIdState: { selId: -1 },
}))
vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: () => {},
    saveAsset: async () => '',
}))
vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: null } }))
vi.mock('../alert', () => ({ notifySuccess: () => {}, alertError: () => {} }))
vi.mock('../../lang', () => ({ language: {}, changeLanguage: () => {} }))

const { setDatabaseLite } = await import('./database.svelte')
const { isChatStub } = await import('./chatStub')

describe('database chat normalization', () => {
    it('preserves server stubs while assigning ids to hydrated messages', () => {
        const stub = { id: 'stub-chat', name: 'Stub', _stub: true }
        const full: {
            id: string
            name: string
            message: Array<{ role: string, data: string, chatId?: string }>
        } = {
            id: 'full-chat',
            name: 'Full',
            message: [{ role: 'user', data: 'Hello' }],
        }
        const database = {
            characters: [{ chats: [stub, full] }],
        } as any

        setDatabaseLite(database)

        expect(isChatStub(stub)).toBe(true)
        expect(stub).not.toHaveProperty('message')
        expect(full.message[0].chatId).toEqual(expect.any(String))
    })
})

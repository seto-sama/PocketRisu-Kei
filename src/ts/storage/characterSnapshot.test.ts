import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    saveAsset: async () => '',
}))
vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: null } }))
vi.mock('../alert', () => ({ notifySuccess: vi.fn(), alertError: vi.fn() }))
vi.mock('../../lang', () => ({ language: {}, changeLanguage: vi.fn() }))
vi.mock('../process/modules', () => ({ moduleUpdate: vi.fn() }))
vi.mock('../gui/deepTouch.svelte', () => ({ deepTouch: vi.fn() }))
vi.mock('../process/scripts', () => ({ resetScriptCache: vi.fn() }))
vi.mock('../gui/breakpoints', () => ({ lgViewport: { matches: () => false } }))

const { getCharacterByIndex, getCurrentCharacter, getDatabase } = await import('./database.svelte')
const { DBState, selectedCharID } = await import('../stores.svelte')

const previousDatabase = DBState.db

afterEach(() => {
    DBState.db = previousDatabase
    selectedCharID.set(-1)
})

describe('character snapshots', () => {
    it('initializes the live database character list when it is missing', () => {
        DBState.db = {} as any

        expect(getCharacterByIndex(0, { snapshot: true })).toBeUndefined()
        expect(DBState.db.characters).toEqual([])
    })

    it('snapshots the requested character without visiting unrelated database data', () => {
        let unrelatedReads = 0
        const unrelated = Object.defineProperty({}, 'expensive', {
            enumerable: true,
            get() {
                unrelatedReads += 1
                throw new Error('unrelated data should not be read')
            },
        })
        DBState.db = {
            characters: [{ name: 'selected', chats: [{ message: [{ data: 'hello' }] }] }],
            pluginCustomStorage: { unrelated },
        } as any

        expect(getCharacterByIndex(0, { snapshot: true })).toMatchObject({ name: 'selected' })
        expect(unrelatedReads).toBe(0)
    })

    it('uses the selected index and returns a detached character snapshot', () => {
        DBState.db = {
            characters: [
                { name: 'first', chats: [] },
                { name: 'second', chats: [{ message: [{ data: 'original' }] }] },
            ],
        } as any
        selectedCharID.set(1)

        const live = getCharacterByIndex(1)
        const snapshot = getCurrentCharacter({ snapshot: true })
        expect(live).toBe(DBState.db.characters[1])
        expect(snapshot).toMatchObject({ name: 'second' })

        snapshot.name = 'changed'
        snapshot.chats[0].message[0].data = 'changed'
        expect(DBState.db.characters[1].name).toBe('second')
        expect(DBState.db.characters[1].chats[0].message[0].data).toBe('original')
    })

    it('keeps whole-database snapshots inclusive and detached', () => {
        DBState.db = {
            characters: [{ name: 'character', chats: [] }],
            pluginCustomStorage: { unrelated: { value: 'database data' } },
        } as any

        const snapshot = getDatabase({ snapshot: true })
        expect(snapshot.pluginCustomStorage.unrelated).toEqual({ value: 'database data' })
        snapshot.characters[0].name = 'changed'
        snapshot.pluginCustomStorage.unrelated.value = 'changed'

        expect(DBState.db.characters[0].name).toBe('character')
        expect(DBState.db.pluginCustomStorage.unrelated.value).toBe('database data')
    })
})

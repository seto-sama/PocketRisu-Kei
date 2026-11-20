import { get, writable } from 'svelte/store'
import { beforeEach, expect, it, vi } from 'vitest'
import type { character } from './storage/database.svelte'

const mocks = vi.hoisted(() => ({
    db: { characters: [] as character[] },
    alertAddCharacter: vi.fn(),
    selectFileByDom: vi.fn(),
    importCharacterProcess: vi.fn(),
    importCharacterPackage: vi.fn(),
}))

vi.mock('./storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
    getCharacterByIndex: (index: number) => mocks.db.characters[index],
    setCharacterByIndex: (index: number, character: character) => { mocks.db.characters[index] = character },
    getCurrentChat: () => null,
    newChatModelDefaults: () => ({}),
}))
vi.mock('./stores.svelte', () => ({
    selectedCharID: writable(-1),
    chatDeselected: writable(false),
    dismissClaimedLoadingOverlay: vi.fn(),
}))
vi.mock('./alert', () => ({ alertAddCharacter: mocks.alertAddCharacter }))
vi.mock('./util', () => ({
    selectFileByDom: mocks.selectFileByDom,
    checkNullish: (value: unknown) => value === null || value === undefined,
}))
vi.mock('./globalApi.svelte', () => ({ checkCharOrder: vi.fn() }))
vi.mock('./characterCards', () => ({ importCharacterProcess: mocks.importCharacterProcess }))
vi.mock('./characterPackage', () => ({ importCharacterPackage: mocks.importCharacterPackage }))
vi.mock('./parser/parser.svelte', () => ({}))
vi.mock('./translator/translator', () => ({}))
vi.mock('./bookmarks/bookmarkService', () => ({}))
vi.mock('./chatImport', () => ({}))

import { addCharacter, changeChar, createBlankChar, migrateEmotionImagesToAssets } from './characters'
import { selectedCharID } from './stores.svelte'

beforeEach(() => {
    vi.resetAllMocks()
    mocks.db.characters = [createBlankChar(), { ...createBlankChar(), trashTime: 1 }]
    mocks.alertAddCharacter.mockResolvedValue('importCharacter')
    mocks.selectFileByDom.mockResolvedValue([])
    selectedCharID.set(-1)
})

it.each([-1, 0])('preserves selection %i when file selection is cancelled and the last character is trashed', async selected => {
    selectedCharID.set(selected)

    await addCharacter()

    expect(get(selectedCharID)).toBe(selected)
})

it.each(['invalid.json', 'cancelled.zip'])('keeps the current screen when importing %s adds no character', async name => {
    mocks.selectFileByDom.mockResolvedValue([new File([''], name)])

    await addCharacter()

    expect(get(selectedCharID)).toBe(-1)
})

it('selects the last new character after importing character and package files', async () => {
    mocks.selectFileByDom.mockResolvedValue([new File([''], 'card.charx'), new File([''], 'package.zip')])
    mocks.importCharacterProcess.mockImplementation(async () => { mocks.db.characters.push(createBlankChar()) })
    mocks.importCharacterPackage.mockImplementation(async () => { mocks.db.characters.push(createBlankChar()) })

    await addCharacter()

    expect(mocks.db.characters).toHaveLength(4)
    expect(get(selectedCharID)).toBe(3)
})

it('selects a character created from scratch', async () => {
    mocks.alertAddCharacter.mockResolvedValue('createfromScratch')

    await addCharacter()

    expect(mocks.db.characters).toHaveLength(3)
    expect(get(selectedCharID)).toBe(2)
})

it('resolves a character UUID against the current array order', () => {
    const target = mocks.db.characters[0]
    mocks.db.characters.reverse()

    expect(changeChar(target.chaId)).toBe(true)
    expect(mocks.db.characters[get(selectedCharID)].chaId).toBe(target.chaId)
})

it.each(['missing', 'trashed'])('rejects a %s character without resetting the current screen', kind => {
    selectedCharID.set(0)
    const reseter = vi.fn()
    const characterId = kind === 'missing' ? 'missing' : mocks.db.characters[1].chaId

    expect(changeChar(characterId, { reseter })).toBe(false)
    expect(get(selectedCharID)).toBe(0)
    expect(reseter).not.toHaveBeenCalled()
})

it('moves legacy emotion images into additional assets and enables the asset prompt', () => {
    const char = {
        ...createBlankChar(),
        additionalAssets: [['happy', 'assets/happy.png', 'png']],
        emotionImages: [['happy', 'assets/happy.png'], ['happy', 'assets/happy-2.webp'], ['sad', 'assets/sad']],
        viewScreen: 'emotion',
        inlayViewScreen: true,
    } as character

    migrateEmotionImagesToAssets(char)

    expect(char.additionalAssets).toEqual([
        ['happy', 'assets/happy.png', 'png'],
        ['happy', 'assets/happy-2.webp', 'webp'],
        ['sad', 'assets/sad', 'png'],
    ])
    expect(char.prebuiltAssetCommand).toBe(true)
    expect(char).not.toHaveProperty('emotionImages')
    expect(char).not.toHaveProperty('viewScreen')
    expect(char).not.toHaveProperty('inlayViewScreen')
})

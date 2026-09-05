import { get } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { hubType } from './characterCards'

const STORAGE_KEY = 'pocketrisu:realm-mutes:v1'

function card(overrides: Partial<hubType> = {}): hubType {
    return {
        name: 'Character',
        desc: '',
        download: '0',
        id: 'character-1',
        img: '',
        tags: [],
        viewScreen: 'none',
        hasLore: false,
        hasEmotion: false,
        hasAsset: false,
        creator: 'creator-1',
        authorname: 'Creator',
        hot: 0,
        license: '',
        type: '',
        ...overrides,
    }
}

async function loadModule() {
    vi.resetModules()
    return import('./realmMute')
}

describe('Realm mute storage and filtering', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('mutes one character and persists its display metadata', async () => {
        const mute = await loadModule()
        const target = card()

        mute.muteRealmCharacter(target)

        expect(get(mute.realmMuteStore).characters).toEqual([
            { id: target.id, name: target.name, note: '' },
        ])
        expect(mute.filterMutedRealmCharacters([target, card({ id: 'character-2' })], get(mute.realmMuteStore)))
            .toEqual([card({ id: 'character-2' })])
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').characters).toHaveLength(1)
    })

    it('mutes every card by the same stable creator id', async () => {
        const mute = await loadModule()
        const first = card()
        const second = card({ id: 'character-2', name: 'Other character' })
        const unrelated = card({ id: 'character-3', creator: 'creator-2' })

        expect(mute.muteRealmCreator(first)).toBe(true)
        expect(mute.filterMutedRealmCharacters([first, second, unrelated], get(mute.realmMuteStore)))
            .toEqual([unrelated])
        expect(mute.muteRealmCreator(card({ creator: undefined }))).toBe(false)
    })

    it('stores editable notes and preserves them when the same entry is muted again', async () => {
        const mute = await loadModule()
        const target = card()

        mute.muteRealmCharacter(target)
        mute.setRealmCharacterMuteNote(target.id, 'Repeated stolen uploads')
        mute.muteRealmCharacter({ ...target, name: 'Renamed character' })
        mute.muteRealmCreator(target)
        mute.setRealmCreatorMuteNote(target.creator!, 'Spam')

        expect(get(mute.realmMuteStore)).toEqual({
            characters: [{ id: target.id, name: 'Renamed character', note: 'Repeated stolen uploads' }],
            creators: [{ id: target.creator, name: target.authorname, note: 'Spam' }],
        })
    })

    it('safely normalizes malformed and duplicate cached entries', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            characters: [
                { id: 'same', name: 'Old' },
                { id: 'same', name: 'Latest', note: ' reason ' },
                { name: 'Missing id' },
            ],
            creators: 'invalid',
        }))

        const mute = await loadModule()

        expect(get(mute.realmMuteStore)).toEqual({
            characters: [{ id: 'same', name: 'Latest', note: 'reason' }],
            creators: [],
        })
    })

    it('removes entries individually or all at once', async () => {
        const mute = await loadModule()
        const target = card()
        mute.muteRealmCharacter(target)
        mute.muteRealmCreator(target)

        mute.unmuteRealmCharacter(target.id)
        expect(get(mute.realmMuteStore).characters).toEqual([])
        expect(get(mute.realmMuteStore).creators).toHaveLength(1)

        mute.clearRealmMutes()
        expect(get(mute.realmMuteStore)).toEqual({ characters: [], creators: [] })
    })
})


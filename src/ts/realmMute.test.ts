import { beforeEach, expect, it, vi } from 'vitest'
import type { hubType } from './characterCards'
import type { RealmMuteEntry } from './realmMute'

const STORAGE_KEY = 'pocketrisu:realm-mutes:v1'
const mocks = vi.hoisted(() => ({
    dbState: { db: { blockedRealmCharacters: [] as RealmMuteEntry[], blockedRealmCreators: [] as RealmMuteEntry[] } },
}))
vi.mock('./stores.svelte', () => ({ DBState: mocks.dbState }))

import { clearRealmMutes, filterMutedRealmCharacters, getRealmMutes, migrateRealmMutes,
    muteRealmCharacter, muteRealmCreator, setRealmCharacterMuteNote, unmuteRealmCharacter } from './realmMute'

beforeEach(() => {
    localStorage.clear()
    mocks.dbState.db = { blockedRealmCharacters: [], blockedRealmCreators: [] }
})

it('stores mutes and notes in the database and updates visible cards when unmuted', () => {
    const character = { id: 'character', name: 'Character', creator: 'creator' } as hubType
    const other = { id: 'other', name: 'Other', creator: 'other-creator' } as hubType
    muteRealmCharacter(character)
    setRealmCharacterMuteNote(character.id, 'Spam')
    muteRealmCreator(other)

    expect(mocks.dbState.db.blockedRealmCharacters).toEqual([{ id: character.id, name: character.name, note: 'Spam' }])
    expect(filterMutedRealmCharacters([character, other], getRealmMutes())).toEqual([])
    unmuteRealmCharacter(character.id)
    expect(filterMutedRealmCharacters([character, other], getRealmMutes())).toEqual([character])
    clearRealmMutes()
    expect(filterMutedRealmCharacters([character, other], getRealmMutes())).toEqual([character, other])
})

it('merges local mutes into existing database entries and removes the migrated local key', async () => {
    mocks.dbState.db.blockedRealmCreators = [{ id: 'creator', name: 'Database name' }]
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        characters: [{ id: 'character', name: 'Character', note: 'Spam' }],
        creators: [
            { id: 'creator', name: 'Old name', note: 'Local note' },
            { id: 'local-creator', name: 'Local creator' },
        ],
    }))

    await migrateRealmMutes(async () => {})

    expect(getRealmMutes()).toEqual({
        characters: [{ id: 'character', name: 'Character', note: 'Spam' }],
        creators: [
            { id: 'creator', name: 'Database name', note: 'Local note' },
            { id: 'local-creator', name: 'Local creator', note: '' },
        ],
    })
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
})

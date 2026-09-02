import { get, writable } from 'svelte/store'
import type { hubType } from './characterCards'

const REALM_MUTE_STORAGE_KEY = 'pocketrisu:realm-mutes:v1'

export interface RealmMutedCharacter {
    id: string
    name: string
    note: string
}

export interface RealmMutedCreator {
    id: string
    name: string
    note: string
}

export interface RealmMuteState {
    characters: RealmMutedCharacter[]
    creators: RealmMutedCreator[]
}

function normalizeEntries(value: unknown): { id: string; name: string; note: string }[] {
    if (!Array.isArray(value)) return []

    const entries = new Map<string, { id: string; name: string; note: string }>()
    for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const id = typeof (item as { id?: unknown }).id === 'string'
            ? (item as { id: string }).id.trim()
            : ''
        if (!id) continue
        const rawName = (item as { name?: unknown }).name
        const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : id
        const rawNote = (item as { note?: unknown }).note
        const note = typeof rawNote === 'string' ? rawNote.trim() : ''
        entries.set(id, { id, name, note })
    }
    return [...entries.values()]
}

function loadRealmMutes(): RealmMuteState {
    if (typeof localStorage === 'undefined') return { characters: [], creators: [] }

    try {
        const parsed = JSON.parse(localStorage.getItem(REALM_MUTE_STORAGE_KEY) ?? '{}') as {
            characters?: unknown
            creators?: unknown
        }
        return {
            characters: normalizeEntries(parsed.characters),
            creators: normalizeEntries(parsed.creators),
        }
    } catch {
        return { characters: [], creators: [] }
    }
}

function persistRealmMutes(state: RealmMuteState) {
    if (typeof localStorage === 'undefined') return
    try {
        localStorage.setItem(REALM_MUTE_STORAGE_KEY, JSON.stringify(state))
    } catch {
        // Storage may be unavailable in private or restricted browser contexts.
    }
}

export const realmMuteStore = writable<RealmMuteState>(loadRealmMutes())

function updateRealmMutes(updater: (state: RealmMuteState) => RealmMuteState) {
    const next = updater(get(realmMuteStore))
    realmMuteStore.set(next)
    persistRealmMutes(next)
}

export function getRealmCreatorName(chara: hubType): string {
    return chara.authorname?.trim()
        || chara.creatorName?.trim()
        || chara.creator?.trim()
        || ''
}

export function muteRealmCharacter(chara: hubType) {
    updateRealmMutes(state => ({
        ...state,
        characters: [
            ...state.characters.filter(entry => entry.id !== chara.id),
            {
                id: chara.id,
                name: chara.name || chara.id,
                note: state.characters.find(entry => entry.id === chara.id)?.note ?? '',
            },
        ],
    }))
}

export function muteRealmCreator(chara: hubType): boolean {
    const id = chara.creator?.trim()
    if (!id) return false

    updateRealmMutes(state => ({
        ...state,
        creators: [
            ...state.creators.filter(entry => entry.id !== id),
            {
                id,
                name: getRealmCreatorName(chara) || id,
                note: state.creators.find(entry => entry.id === id)?.note ?? '',
            },
        ],
    }))
    return true
}

export function unmuteRealmCharacter(id: string) {
    updateRealmMutes(state => ({
        ...state,
        characters: state.characters.filter(entry => entry.id !== id),
    }))
}

export function unmuteRealmCreator(id: string) {
    updateRealmMutes(state => ({
        ...state,
        creators: state.creators.filter(entry => entry.id !== id),
    }))
}

export function setRealmCharacterMuteNote(id: string, note: string) {
    updateRealmMutes(state => ({
        ...state,
        characters: state.characters.map(entry => entry.id === id
            ? { ...entry, note: note.trim() }
            : entry),
    }))
}

export function setRealmCreatorMuteNote(id: string, note: string) {
    updateRealmMutes(state => ({
        ...state,
        creators: state.creators.map(entry => entry.id === id
            ? { ...entry, note: note.trim() }
            : entry),
    }))
}

export function clearRealmMutes() {
    updateRealmMutes(() => ({ characters: [], creators: [] }))
}

export function filterMutedRealmCharacters(charas: hubType[], state: RealmMuteState): hubType[] {
    if (state.characters.length === 0 && state.creators.length === 0) return charas

    const characterIds = new Set(state.characters.map(entry => entry.id))
    const creatorIds = new Set(state.creators.map(entry => entry.id))
    return charas.filter(chara =>
        !characterIds.has(chara.id)
        && (!chara.creator?.trim() || !creatorIds.has(chara.creator.trim()))
    )
}

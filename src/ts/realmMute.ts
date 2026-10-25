import { toStore, type Readable } from 'svelte/store'
import { DBState } from './stores.svelte'
import type { hubType } from './characterCards'

const REALM_MUTE_STORAGE_KEY = 'pocketrisu:realm-mutes:v1'

export interface RealmMuteEntry {
    id: string
    name: string
    note?: string
}

export interface RealmMuteState {
    characters: RealmMuteEntry[]
    creators: RealmMuteEntry[]
}

function normalizeEntries(value: unknown): RealmMuteEntry[] {
    if (!Array.isArray(value)) return []

    const entries = new Map<string, RealmMuteEntry>()
    for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const entry = item as Partial<RealmMuteEntry>
        const id = typeof entry.id === 'string' ? entry.id.trim() : ''
        if (!id) continue
        const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id
        const note = typeof entry.note === 'string' ? entry.note.trim() : ''
        entries.set(id, { id, name, note })
    }
    return [...entries.values()]
}

function loadRealmMutes(raw: string): RealmMuteState {
    try {
        const parsed = JSON.parse(raw) as {
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

export function getRealmMutes(): RealmMuteState {
    return {
        characters: DBState.db.blockedRealmCharacters ?? [],
        creators: DBState.db.blockedRealmCreators ?? [],
    }
}

export const realmMuteStore: Readable<RealmMuteState> = {
    // Defer DBState access until module initialization has finished.
    subscribe: (run, invalidate) => toStore(getRealmMutes).subscribe(run, invalidate),
}

export async function migrateRealmMutes(save: () => Promise<void> | void) {
    const raw = localStorage.getItem(REALM_MUTE_STORAGE_KEY)
    if (raw === null) return
    const legacy = loadRealmMutes(raw)
    if (legacy.characters.length || legacy.creators.length) {
        const merge = (current: RealmMuteEntry[], local: RealmMuteEntry[]) => {
            const entries = new Map(current.map(entry => [entry.id, entry]))
            for (const entry of local) {
                const existing = entries.get(entry.id)
                entries.set(entry.id, existing ? { ...existing, note: existing.note ?? entry.note } : entry)
            }
            return [...entries.values()]
        }
        const state = getRealmMutes()
        DBState.db.blockedRealmCharacters = merge(state.characters, legacy.characters)
        DBState.db.blockedRealmCreators = merge(state.creators, legacy.creators)
        await save()
    }
    localStorage.removeItem(REALM_MUTE_STORAGE_KEY)
}

export function isRealmMuted(id: string, creator?: string): boolean {
    const state = getRealmMutes()
    const creatorId = creator?.trim()
    return state.characters.some(entry => entry.id === id)
        || !!creatorId && state.creators.some(entry => entry.id === creatorId)
}

function addMute(entries: RealmMuteEntry[], id: string, name: string): RealmMuteEntry[] {
    return [
        ...entries.filter(entry => entry.id !== id),
        { id, name, note: entries.find(entry => entry.id === id)?.note ?? '' },
    ]
}

export function muteRealmCharacter(chara: hubType) {
    DBState.db.blockedRealmCharacters = addMute(getRealmMutes().characters, chara.id, chara.name || chara.id)
}

export function muteRealmCreator(chara: hubType) {
    const id = chara.creator?.trim()
    if (!id) return
    const name = chara.authorname?.trim() || chara.creatorName?.trim() || id
    DBState.db.blockedRealmCreators = addMute(getRealmMutes().creators, id, name)
}

export function unmuteRealmCharacter(id: string) {
    DBState.db.blockedRealmCharacters = getRealmMutes().characters.filter(entry => entry.id !== id)
}

export function unmuteRealmCreator(id: string) {
    DBState.db.blockedRealmCreators = getRealmMutes().creators.filter(entry => entry.id !== id)
}

function setMuteNote(entries: RealmMuteEntry[], id: string, note: string): RealmMuteEntry[] {
    return entries.map(entry => entry.id === id ? { ...entry, note: note.trim() } : entry)
}

export function setRealmCharacterMuteNote(id: string, note: string) {
    DBState.db.blockedRealmCharacters = setMuteNote(getRealmMutes().characters, id, note)
}

export function setRealmCreatorMuteNote(id: string, note: string) {
    DBState.db.blockedRealmCreators = setMuteNote(getRealmMutes().creators, id, note)
}

export function clearRealmMutes() {
    DBState.db.blockedRealmCharacters = []
    DBState.db.blockedRealmCreators = []
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

import { SvelteMap } from 'svelte/reactivity'
import { readViewPreference, writeViewPreference } from '../viewPreference'

type ChatCharacter = { chaId?: string; chats?: { id?: string }[] }
type Selection = { id: string; index: number }
const selections = new SvelteMap<string, Selection>()
const selectionKey = (id: string) => `pocketrisu:chat-selection:${id}`

export function getChatPage(character?: ChatCharacter): number {
    const chats = character?.chats ?? []
    const selection = selections.get(character?.chaId)
    if (selection?.id && chats[selection.index]?.id === selection.id) return selection.index
    const id = selection?.id ?? (character?.chaId
        ? readViewPreference(selectionKey(character.chaId), chats.map(chat => chat.id ?? ''), '') : '')
    const index = id ? chats.findIndex(chat => chat.id === id) : -1
    return index >= 0 ? index : Math.max(0, Math.min(selection?.index ?? 0, chats.length - 1))
}

export function setChatPage(character: ChatCharacter, index: number) {
    const chat = character?.chats?.[index]
    if (!character?.chaId || !chat || !Number.isInteger(index)) return
    const id = chat.id ?? ''
    const previous = selections.get(character.chaId)
    if (previous?.id === id && previous.index === index) return
    selections.set(character.chaId, { id, index })
    if (id && previous?.id !== id) writeViewPreference(selectionKey(character.chaId), id)
}

/** Migrate old saves or plugin payloads without retaining selection on the character. */
export function initializeChatSelection(character: ChatCharacter, preferLegacy = false) {
    const legacy = character as ChatCharacter & { chatPage?: number }
    const page = legacy.chatPage
    const cached = character.chaId && readViewPreference(selectionKey(character.chaId),
        (character.chats ?? []).map(chat => chat.id ?? ''), '')
    if (Number.isInteger(page) && (preferLegacy || (!selections.has(character.chaId) && !cached))) setChatPage(character, page)
    else setChatPage(character, getChatPage(character))
    delete legacy.chatPage
}

/** Legacy plugins still receive their selected index in an isolated API snapshot. */
export function withChatSelection<T extends ChatCharacter>(character: T): T & { chatPage: number } {
    return character ? { ...character, chatPage: getChatPage(character) } : character as T & { chatPage: number }
}

const pluginViews = new WeakMap<object, object>()

/** Keep legacy direct mutations local while forwarding other live database edits. */
export function pluginCharacterSelections<T extends ChatCharacter>(characters: T[]): T[] {
    const existing = pluginViews.get(characters)
    if (existing) return existing as T[]
    const view = new Proxy(characters, {
        get(target, key, receiver) {
            const character = Reflect.get(target, key, receiver)
            if (typeof key !== 'string' || !/^\d+$/.test(key) || !character) return character
            const existing = pluginViews.get(character)
            if (existing) return existing
            const view = new Proxy(character, {
                get(target, key, receiver) {
                    return key === 'chatPage' ? getChatPage(target) : Reflect.get(target, key, receiver)
                },
                set(target, key, value, receiver) {
                    if (key !== 'chatPage') return Reflect.set(target, key, value, receiver)
                    setChatPage(target, value)
                    return true
                },
                ownKeys(target) { return [...new Set([...Reflect.ownKeys(target), 'chatPage'])] },
                getOwnPropertyDescriptor(target, key) {
                    return key === 'chatPage'
                        ? { configurable: true, enumerable: true, writable: true, value: getChatPage(target) }
                        : Reflect.getOwnPropertyDescriptor(target, key)
                },
            })
            pluginViews.set(character, view)
            return view
        },
        set(target, key, value, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key) && value) initializeChatSelection(value, true)
            return Reflect.set(target, key, value, receiver)
        },
    })
    pluginViews.set(characters, view)
    return view
}

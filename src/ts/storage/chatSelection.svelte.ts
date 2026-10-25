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

export function withChatSelection<T extends ChatCharacter>(character: T): T & { chatPage: number } {
    return character ? { ...character, chatPage: getChatPage(character) } : character as T & { chatPage: number }
}

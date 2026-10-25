import { getChatPage } from 'src/ts/storage/chatSelection.svelte'
import { get } from 'svelte/store'
import { DBState, selectedCharID } from '../stores.svelte'
import { parseKeyValue } from '../util'
import type { Chat } from '../storage/database.svelte'

export function getChatVar(key:string): string {
    const selectedChar = get(selectedCharID)
    const char = DBState.db.characters[selectedChar]
    if(!char){
        return ''
    }
    return getChatVarOf(char.chats[getChatPage(char)], key, char.defaultVariables)
}

export function getChatVarOf(chat: Chat, key: string, defaults = ''): string {
    chat.scriptstate ??= {}
    const state = (chat.scriptstate['$' + key])
    if(state === undefined || state === null){
        const defaultVariables = parseKeyValue(defaults).concat(parseKeyValue(DBState.db.templateDefaultVariables))
        const findResult = defaultVariables.find((f) => {
            return f[0] === key
        })
        if(findResult){
            return findResult[1]
        }
        return ''
    }
    return state.toString()
}

export function setChatVar(key:string, value:string): void {
    const selectedChar = get(selectedCharID)
    const char = DBState.db.characters[selectedChar]
    const chat = char.chats[getChatPage(char)]
    setChatVarOf(chat, key, value)
}

export function setChatVarOf(chat: Chat, key: string, value: string): void {
    chat.scriptstate ??= {}
    chat.scriptstate['$' + key] = value
}

export function getGlobalChatVar(key:string): string {
    return DBState.db.globalChatVariables[key] ?? ''
}

import { getDatabase, normalizeChat, type Chat } from '../storage/database.svelte'
import { markChatWorkingCopyDirty, type ChatWorkingCopyTarget } from '../storage/chatWorkingCopy'
import { requestImmediateSave } from '../globalApi.svelte'

export function resolveTriggerOrigin(target: ChatWorkingCopyTarget) {
    const character = getDatabase().characters.find(character => character.chaId === target.characterId)
    const index = character?.chats.findIndex(chat => chat.id === target.chatId) ?? -1
    return character && index >= 0 ? { character, index, chat: character.chats[index] } : null
}

export async function commitTriggerChat(target: ChatWorkingCopyTarget, chat: Chat): Promise<boolean> {
    const origin = resolveTriggerOrigin(target)
    if (!origin) return false
    markChatWorkingCopyDirty(target.characterId, target.chatId)
    origin.character.chats[origin.index] = normalizeChat({ ...chat, id: target.chatId })
    await requestImmediateSave({ characterIds: [target.characterId], chatTargets: [target] })
    return true
}

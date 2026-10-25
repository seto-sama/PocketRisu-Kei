import { createEntityId } from 'src/ts/id';
import { language } from 'src/lang'
import { notifySuccess } from './alert'
import { getCurrentChat, getDatabase } from './storage/database.svelte'

export function bindPromptPresetToCurrentChat(presetId: string): boolean {
    const chat = getCurrentChat()
    if (!chat) return false
    if (presetId === '') {
        chat.bindedBotPreset = ''
        notifySuccess(language.promptUnbindedSuccess)
        return true
    }
    const preset = getDatabase().botPresets.find(item => item.id === presetId)
    if (!preset) return false

    chat.bindedBotPreset = preset.id
    notifySuccess(language.promptBindedSuccess)
    return true
}

export function bindPersonaToCurrentChat(personaIndex: number): boolean {
    const chat = getCurrentChat()
    if (!chat) return false
    if (personaIndex === -1) {
        chat.bindedPersona = ''
        notifySuccess(language.personaUnbindedSuccess)
        return true
    }
    const persona = getDatabase().personas[personaIndex]
    if (!persona) return false

    persona.id ||= createEntityId()
    chat.bindedPersona = persona.id
    notifySuccess(language.personaBindedSuccess)
    return true
}

import { createEntityId } from 'src/ts/id';
import { language } from 'src/lang'
import { notifySuccess } from './alert'
import { getCurrentChat, getDatabase } from './storage/database.svelte'

export function bindPromptPresetToCurrentChat(presetIndex: number): boolean {
    const chat = getCurrentChat()
    if (!chat) return false
    if (presetIndex === -1) {
        chat.bindedBotPreset = ''
        notifySuccess(language.promptUnbindedSuccess)
        return true
    }
    const preset = getDatabase().botPresets[presetIndex]
    if (!preset) return false

    preset.id ||= createEntityId()
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

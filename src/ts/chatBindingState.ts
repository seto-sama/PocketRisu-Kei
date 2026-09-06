import type { Chat, Database } from './storage/database.svelte'

export function getEffectiveModelBinding(
    db: Pick<Database, 'showModelInSidebar' | 'defaultModelBinding'>,
    chat: Pick<Chat, 'modelBinding'> | null | undefined,
) {
    return db.showModelInSidebar === false
        ? db.defaultModelBinding
        : chat?.modelBinding ?? db.defaultModelBinding
}

// Missing flags retain the enabled defaults used by older databases.
export function getChatBoundPersona(
    db: Pick<Database, 'personas'> & Partial<Pick<Database, 'showPersonaInSidebar'>>,
    chat: Pick<Chat, 'bindedPersona'> | undefined,
) {
    if (db.showPersonaInSidebar === false || !chat?.bindedPersona) return null
    return db.personas?.find(persona => persona.id === chat.bindedPersona) ?? null
}

export function getChatBoundPromptPresetIndex(
    db: Pick<Database, 'showPresetInSidebar' | 'botPresets'>,
    chat: Pick<Chat, 'bindedBotPreset'> | undefined,
): number {
    if (db.showPresetInSidebar === false || !chat?.bindedBotPreset) return -1
    return db.botPresets.findIndex(preset => preset.id === chat.bindedBotPreset)
}

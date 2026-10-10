import { getChatBoundPersona } from '../chatBindingState'
import type { Chat, Database, character } from '../storage/database.svelte'
import type { RisuModule } from './modules'

export function clearCharacterModuleConnections(db: Pick<Database, 'characters'>, moduleId: string): void {
    for (const char of db.characters) {
        if (char.modules?.includes(moduleId)) {
            char.modules = char.modules.filter(id => id !== moduleId)
        }
        for (const chat of char.chats) {
            if (chat.modules?.includes(moduleId)) {
                chat.modules = chat.modules.filter(id => id !== moduleId)
            }
        }
    }
}

export function setGlobalModuleEnabled(
    db: Pick<Database, 'enabledModules' | 'characters'>,
    moduleId: string,
    enabled: boolean,
): void {
    const ids = new Set(db.enabledModules)
    if (enabled) {
        ids.add(moduleId)
        clearCharacterModuleConnections(db, moduleId)
    } else {
        ids.delete(moduleId)
    }
    db.enabledModules = [...ids]
}

export function getEnabledModules(db: Database, char: character | undefined, chat: Chat | undefined): RisuModule[] {
    const boundPersona = getChatBoundPersona(db, chat)
    const persona = boundPersona ?? db.personas?.[db.selectedPersona]
    const ids = new Set([
        ...(db.enabledModules ?? []),
        ...((persona?.id && db.personaEnabledModules?.[persona.id]) ? db.personaEnabledModules[persona.id] : []),
        ...(char?.modules ?? []),
        ...(chat?.modules ?? []),
        ...(boundPersona?.embeddedModule ? [boundPersona.embeddedModule.id] : []),
        ...(db.moduleIntergration?.split(',').map(value => value.trim()).filter(Boolean) ?? []),
    ])
    const seen = new Set<string>()
    return (db.modules ?? []).filter(module => {
        if (!module || seen.has(module.id) || (!ids.has(module.id) && !(module.namespace && ids.has(module.namespace)))) {
            return false
        }
        seen.add(module.id)
        return true
    })
}

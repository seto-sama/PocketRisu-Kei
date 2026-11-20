import { language } from 'src/lang'
import type { PromptItem, PromptItemPlain, PromptItemCache, PromptRole } from './prompt'

export function promptTypeLabel(type: PromptItem['type']): string {
    switch (type) {
        case 'plain': return language.formating.plain
        case 'jailbreak': return language.formating.jailbreak
        case 'chat': return language.Chat
        case 'persona': return language.formating.personaPrompt
        case 'description': return language.formating.description
        case 'authornote': return language.formating.authorNote
        case 'lorebook': return language.formating.lorebook
        case 'memory': return language.formating.memory
        case 'postEverything': return language.formating.postEverything
        case 'chatML': return 'ChatML'
        case 'cache': return language.cachePoint
    }
}

export function promptType2Label(type2: PromptItemPlain['type2']): string | null {
    switch (type2) {
        case 'main': return language.mainPrompt
        case 'globalNote': return language.globalNote
        case 'normal': return null
    }
}

export function promptRoleLabel(role: PromptRole | PromptItemCache['role']): string {
    return {
        user: language.user,
        bot: language.character,
        assistant: language.character,
        system: language.systemPrompt,
        all: language.all,
    }[role]
}

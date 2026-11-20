import type { Chat } from '../../../storage/database.svelte'
import { applyRegexScripts } from '../../regexScriptCore'
import { renderRevenantTemplate } from './headlessParser'
import type { RevenantPostprocessRecipe } from '../types'

export interface RevenantOutputTransformResult {
    text: string
    chat: Chat
    errors: string[]
}

export function runRevenantOutputTransform(
    content: string,
    recipe: RevenantPostprocessRecipe,
    sourceChat: Chat = structuredClone(recipe.chat),
): RevenantOutputTransformResult {
    const chat = structuredClone(sourceChat)
    const chatID = chat.message.findIndex(message => message?.chatId === recipe.messageChatId)
    // Rendering mutates `chat` in place, so variable writes carry across scripts.
    const parse = (text: string) => renderRevenantTemplate(text, recipe, chat, { chatID }).text
    const errors: string[] = []
    const scripts = [
        ...(recipe.database.presetRegex ?? []),
        ...(recipe.character.customscript ?? []),
        ...(recipe.moduleRegexScripts ?? []),
    ]
    const text = applyRegexScripts(parse(content), scripts, 'editoutput', {
        chatID,
        parse,
        getTarget: () => ({ chat, character: recipe.character }),
        onError: error => errors.push(error instanceof Error ? error.message : String(error)),
    })
    return { text, chat, errors }
}

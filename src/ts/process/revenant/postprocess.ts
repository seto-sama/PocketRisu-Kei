import type { Chat, customscript } from '../../storage/database.svelte'
import { renderRevenantTemplate } from './headlessParser'
import type { RevenantPostprocessRecipe } from './types'

export type RevenantForegroundEffect =
    | { kind: 'emotion', name: string }

export interface RevenantOutputTransformResult {
    text: string
    chat: Chat
    foregroundEffects: RevenantForegroundEffect[]
    errors: string[]
}

type ParsedScript = {
    script: customscript
    order: number
    actions: string[]
}

function parseScript(script: customscript): ParsedScript {
    if (!script.ableFlag || !script.flag?.includes('<')) {
        return { script, order: 0, actions: [] }
    }
    let order = 0
    const actions: string[] = []
    const normalized = structuredClone(script)
    normalized.flag = normalized.flag?.replace(/<(.+?)>/g, (_whole, body: string) => {
        for (const item of body.split(',').map(value => value.trim())) {
            if (item.startsWith('order ')) order = Number.parseInt(item.slice(6), 10) || 0
            else if (item) actions.push(item)
        }
        return ''
    })
    return { script: normalized, order, actions }
}

function createRegex(script: customscript): RegExp {
    let flags = script.ableFlag ? script.flag || 'g' : 'g'
    flags = flags.trim().replace(/[^dgimsuvy]/g, '')
    flags = [...flags].filter((flag, index, all) => all.indexOf(flag) === index).join('')
    return new RegExp(script.in, flags || 'u')
}

function replacementForMatch(template: string, match: RegExpMatchArray): string {
    return template
        .replace(/(?<!\$)\$([0-9]+)/g, (whole, index) => match[Number(index)] ?? whole)
        .replace(/\$&/g, match[0])
        .replace(/(?<!\$)\$<([^>]+)>/g, (whole, name) => match.groups?.[name] ?? whole)
}

export function runRevenantOutputTransform(
    content: string,
    recipe: RevenantPostprocessRecipe,
    sourceChat: Chat = structuredClone(recipe.chat),
): RevenantOutputTransformResult {
    let chat = structuredClone(sourceChat)
    let parsed = renderRevenantTemplate(content, recipe, chat)
    let text = parsed.text
    chat = parsed.chat
    const foregroundEffects: RevenantForegroundEffect[] = []
    const errors: string[] = []
    const scripts = [
        ...(recipe.database.presetRegex ?? []),
        ...(recipe.character.customscript ?? []),
        ...(recipe.moduleRegexScripts ?? []),
    ].map(parseScript).sort((left, right) => right.order - left.order)

    for (const item of scripts) {
        const script = item.script
        if (script.type !== 'editoutput' || !script.in) continue
        try {
            let input = script.in
            if (item.actions.includes('cbs')) {
                input = renderRevenantTemplate(input, recipe, chat).text
            }
            const regex = createRegex({ ...script, in: input })
            let output = script.out.replaceAll('$n', '\n').replace(/{{data}}/g, '$&')
            const moveTop = output.startsWith('@@move_top') || item.actions.includes('move_top')
            const moveBottom = output.startsWith('@@move_bottom') || item.actions.includes('move_bottom')
            if (moveTop || moveBottom) {
                const matches = regex.global ? [...text.matchAll(regex)] : [text.match(regex)].filter(Boolean) as RegExpMatchArray[]
                text = text.replace(regex, '')
                for (const match of matches) {
                    const value = replacementForMatch(
                        output.replace('@@move_top ', '').replace('@@move_bottom ', ''),
                        match,
                    )
                    text = moveTop ? `${value}\n${text}` : `${text}\n${value}`
                }
            }
            else if (regex.test(text)) {
                regex.lastIndex = 0
                if (output.startsWith('@@emo ')) {
                    foregroundEffects.push({ kind: 'emotion', name: script.out.slice(6).trim() })
                }
                else if ((output.startsWith('@@inject') || item.actions.includes('inject'))) {
                    const target = chat.message.findIndex(message => message?.chatId === recipe.messageChatId)
                    if (target >= 0) chat.message[target].data = text
                    text = text.replace(regex, '')
                }
                else {
                    if (output.endsWith('>') && !item.actions.includes('no_end_nl')) output += '\n'
                    text = text.replace(regex, output)
                }
            }
            else if (output.startsWith('@@repeat_back') || item.actions.includes('repeat_back')) {
                const target = chat.message.findIndex(message => message?.chatId === recipe.messageChatId)
                const role = target >= 0 ? chat.message[target]?.role : 'char'
                let previous = recipe.character.firstMessage ?? ''
                for (let index = (target >= 0 ? target : chat.message.length) - 1; index >= 0; index--) {
                    if (chat.message[index]?.role === role) {
                        previous = chat.message[index].data
                        break
                    }
                }
                regex.lastIndex = 0
                const match = previous.match(regex)
                if (match?.[0]) {
                    const position = output.split(' ', 2)[1] ?? 'end'
                    if (position === 'start') text = match[0] + text
                    else if (position === 'start_nl') text = `${match[0]}\n${text}`
                    else if (position === 'end_nl') text = `${text}\n${match[0]}`
                    else text += match[0]
                }
            }
            parsed = renderRevenantTemplate(text, recipe, chat)
            text = parsed.text
            chat = parsed.chat
        }
        catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
        }
    }

    return { text, chat, foregroundEffects, errors }
}

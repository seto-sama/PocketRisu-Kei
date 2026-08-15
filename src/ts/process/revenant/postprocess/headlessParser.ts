import { registerCBS, type RegisterCallback } from '../../../cbs'
import type { Chat, character } from '../../../storage/database.svelte'
import type { RevenantPostprocessRecipe } from '../types'

type TemplateState = {
    recipe: RevenantPostprocessRecipe
    character: character
    chat: Chat
    database: Record<string, any>
    callbacks: Map<string, RegisterCallback>
    functions: Map<string, { body: string, args: string[] }>
    triggerId?: string
}

function normalizeName(value: string): string {
    return value.toLocaleLowerCase().replace(/[\s_-]/g, '')
}

function parseArray(value: string): unknown[] {
    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : value.split('§')
    }
    catch {
        return value.split('§')
    }
}

function parseDict(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    }
    catch {
        return {}
    }
}

function makeArray(value: unknown[]): string {
    return JSON.stringify(value.map(item => typeof item === 'string'
        ? item.replace(/::/g, '\\u003A\\u003A')
        : item))
}

function calculate(expression: string): number {
    const tokens = expression.match(/(?:\d+(?:\.\d+)?)|[()+\-*/%^]|<=|>=|!=|==|<|>/g) ?? []
    let index = 0
    const parsePrimary = (): number => {
        const token = tokens[index++]
        if (token === '(') {
            const value = parseComparison()
            if (tokens[index] === ')') index++
            return value
        }
        if (token === '-') return -parsePrimary()
        if (token === '+') return parsePrimary()
        const value = Number(token)
        return Number.isFinite(value) ? value : 0
    }
    const parsePower = (): number => {
        let value = parsePrimary()
        while (tokens[index] === '^') {
            index++
            value **= parsePrimary()
        }
        return value
    }
    const parseProduct = (): number => {
        let value = parsePower()
        while (['*', '/', '%'].includes(tokens[index])) {
            const operator = tokens[index++]
            const right = parsePower()
            if (operator === '*') value *= right
            else if (operator === '/') value /= right
            else value %= right
        }
        return value
    }
    const parseSum = (): number => {
        let value = parseProduct()
        while (['+', '-'].includes(tokens[index])) {
            const operator = tokens[index++]
            const right = parseProduct()
            value = operator === '+' ? value + right : value - right
        }
        return value
    }
    const parseComparison = (): number => {
        const left = parseSum()
        const operator = tokens[index]
        if (!['<', '>', '<=', '>=', '==', '!='].includes(operator)) return left
        index++
        const right = parseSum()
        switch (operator) {
            case '<': return left < right ? 1 : 0
            case '>': return left > right ? 1 : 0
            case '<=': return left <= right ? 1 : 0
            case '>=': return left >= right ? 1 : 0
            case '==': return left === right ? 1 : 0
            default: return left !== right ? 1 : 0
        }
    }
    return parseComparison()
}

function formatDate(pattern: string, timestamp = 0): string {
    const date = timestamp === 0 ? new Date() : new Date(timestamp)
    return pattern.replace(/^:/, '')
        .replace(/YYYY/g, String(date.getFullYear()))
        .replace(/YY/g, String(date.getFullYear()).slice(-2))
        .replace(/MM/g, String(date.getMonth() + 1).padStart(2, '0'))
        .replace(/DD/g, String(date.getDate()).padStart(2, '0'))
        .replace(/HH/g, String(date.getHours()).padStart(2, '0'))
        .replace(/hh/g, String(date.getHours() % 12 || 12).padStart(2, '0'))
        .replace(/mm/g, String(date.getMinutes()).padStart(2, '0'))
        .replace(/ss/g, String(date.getSeconds()).padStart(2, '0'))
        .replace(/X/g, String(Math.floor(date.getTime() / 1000)))
        .replace(/x/g, String(date.getTime()))
        .replace(/A/g, date.getHours() >= 12 ? 'PM' : 'AM')
}

function chatVariable(state: TemplateState, key: string): string {
    const value = state.chat.scriptstate?.[`$${key}`]
    if (value !== undefined && value !== null) return String(value)
    const defaults = `${state.character.defaultVariables ?? ''}\n${state.recipe.database.templateDefaultVariables ?? ''}`
    for (const line of defaults.split('\n')) {
        const separator = line.indexOf('=')
        if (separator >= 0 && line.slice(0, separator).trim() === key) {
            return line.slice(separator + 1).trim()
        }
    }
    return 'null'
}

function setChatVariable(state: TemplateState, key: string, value: string): void {
    state.chat.scriptstate ??= {}
    state.chat.scriptstate[`$${key}`] = value
}

function selectedPersona(state: TemplateState): any {
    const personas = state.recipe.database.personas ?? []
    return state.chat.bindedPersona
        ? personas.find((item: any) => item?.id === state.chat.bindedPersona)
        : personas[state.recipe.database.selectedPersona ?? 0]
}

function truthy(value: unknown): boolean {
    return value === true || value === 1 || value === '1' || value === 'true'
}

function evaluateWhen(parts: string[], state: TemplateState): boolean {
    const values = [...parts]
    let keep = false
    while (values.length > 1) {
        const right = values.pop() ?? ''
        const operator = values.pop() ?? ''
        const left = values.pop() ?? ''
        switch (operator) {
            case 'keep': keep = true; values.push(right); break
            case 'not': values.push(truthy(right) ? '0' : '1'); values.push(left); break
            case 'and': values.push(truthy(left) && truthy(right) ? '1' : '0'); break
            case 'or': values.push(truthy(left) || truthy(right) ? '1' : '0'); break
            case 'is': values.push(left === right ? '1' : '0'); break
            case 'isnot': values.push(left !== right ? '1' : '0'); break
            case 'var': values.push(left, truthy(chatVariable(state, right)) ? '1' : '0'); break
            case 'toggle': values.push(left, truthy(state.recipe.database.globalChatVariables?.[`toggle_${right}`]) ? '1' : '0'); break
            case '>': values.push(Number(left) > Number(right) ? '1' : '0'); break
            case '<': values.push(Number(left) < Number(right) ? '1' : '0'); break
            case '>=': values.push(Number(left) >= Number(right) ? '1' : '0'); break
            case '<=': values.push(Number(left) <= Number(right) ? '1' : '0'); break
            default: values.push(left, right); break
        }
    }
    void keep
    return truthy(values[0])
}

function unescapeCode(value: string): string {
    return value.trim().replaceAll('\n', '').replaceAll('\t', '')
        .replace(/\\u([0-9A-Fa-f]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\(.)/g, (_match, escaped) => ({ n: '\n', r: '\r', t: '\t' }[escaped] ?? escaped))
}

function splitTopLevelElse(body: string): [string, string] {
    const tokens = /{{([#/:][\s\S]*?)}}/g
    let depth = 0
    let token: RegExpExecArray | null
    while ((token = tokens.exec(body))) {
        if (token[1].startsWith('#')) depth++
        else if (token[1].startsWith('/')) depth = Math.max(0, depth - 1)
        else if (token[1] === ':else' && depth === 0) {
            return [body.slice(0, token.index), body.slice(token.index + token[0].length)]
        }
    }
    return [body, '']
}

function renderNestedBlockDirectives(input: string, state: TemplateState, depth: number): string {
    let output = ''
    let cursor = 0
    while (cursor < input.length) {
        const start = input.indexOf('{{#', cursor)
        if (start < 0) return output + input.slice(cursor)
        output += input.slice(cursor, start)

        let nesting = 1
        let scan = start + 3
        let end = -1
        while (scan < input.length) {
            if (input.startsWith('{{', scan)) {
                nesting++
                scan += 2
                continue
            }
            if (input.startsWith('}}', scan)) {
                nesting--
                scan += 2
                if (nesting === 0) {
                    end = scan
                    break
                }
                continue
            }
            scan++
        }
        if (end < 0) return output + input.slice(start)

        const directive = input.slice(start + 2, end - 2)
        const renderedDirective = directive.includes('{{')
            ? renderTemplate(directive, state, depth + 1)
            : directive
        output += `{{${renderedDirective}}}`
        cursor = end
    }
    return output
}

function renderBlocks(input: string, state: TemplateState, depth: number): string {
    const tokenPattern = /{{([#/:][\s\S]*?)}}/g
    while (true) {
        tokenPattern.lastIndex = 0
        let start: RegExpExecArray | null = null
        while ((start = tokenPattern.exec(input))) {
            if (start[1].startsWith('#')) break
        }
        if (!start) return input
        let nesting = 1
        let end: RegExpExecArray | null = null
        tokenPattern.lastIndex = start.index + start[0].length
        while ((end = tokenPattern.exec(input))) {
            if (end[1].startsWith('#')) nesting++
            else if (end[1].startsWith('/')) nesting--
            if (nesting === 0) break
        }
        if (!end) return input
        const directive = start[1]
        const rawBody = input.slice(start.index + start[0].length, end.index)
        const [truthyBody, falsyBody] = splitTopLevelElse(rawBody)
        let replacement = ''
        if (directive === '#pure' || directive === '#pure_display') replacement = rawBody.trim()
        else if (directive === '#code') replacement = unescapeCode(rawBody)
        else if (directive.startsWith('#escape')) {
            replacement = rawBody.trim().replace(/[&<>'"]/g, character => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
            }[character] ?? character))
        }
        else if (directive.startsWith('#func')) {
            const [name, ...args] = directive.slice(5).trim().split(/\s+/)
            if (name) state.functions.set(name, { body: rawBody, args })
        }
        else if (directive.startsWith('#each')) {
            const expression = directive.slice(5).replace(/^::keep\s+/, '').trim()
            const match = expression.match(/^(.*?)(?:\s+as\s+|\s+)([^\s]+)$/)
            if (match) {
                replacement = parseArray(match[1]).map(item => renderTemplate(
                    rawBody.replaceAll(`{{slot::${match[2]}}}`, typeof item === 'string' ? item : JSON.stringify(item)),
                    state,
                    depth + 1,
                )).join('')
            }
        }
        else {
            let condition = false
            if (directive.startsWith('#if ')) condition = truthy(directive.slice(4).trim())
            else if (directive.startsWith('#if_pure ')) condition = truthy(directive.slice(9).trim())
            else if (directive.startsWith('#when::')) condition = evaluateWhen(directive.split('::').slice(1), state)
            else if (directive.startsWith('#when ')) condition = truthy(directive.slice(6).trim())
            replacement = renderTemplate(condition ? truthyBody : falsyBody, state, depth + 1).trim()
        }
        input = input.slice(0, start.index) + replacement + input.slice(end.index + end[0].length)
    }
}

function renderTemplate(input: string, state: TemplateState, depth = 0): string {
    if (depth > 20) return 'ERROR: Call stack limit reached'
    const normalized = renderNestedBlockDirectives(
        input.replace(/\<(user|char|bot)\>/gi, '{{$1}}'),
        state,
        depth,
    )
    let rendered = renderBlocks(normalized, state, depth)
    const matcherArg: any = {
        chatID: state.chat.message.length - 1,
        db: state.database,
        chara: state.character,
        rmVar: false,
        var: null,
        tokenizeAccurate: false,
        consistantChar: false,
        displaying: false,
        runVar: false,
        cbsConditions: {},
        callStack: depth,
    }
    for (let pass = 0; pass < 64; pass++) {
        let changed = false
        rendered = rendered.replace(/{{([^{}]*)}}/g, (whole, body: string) => {
            if (body.startsWith('call::')) {
                const [name, ...args] = body.split('::').slice(1)
                const fn = state.functions.get(name)
                if (!fn) return whole
                let value = fn.body
                args.forEach((arg, index) => { value = value.replaceAll(`{{arg::${index}}}`, arg) })
                changed = true
                return renderTemplate(value, state, depth + 1)
            }
            const separator = body.includes('::') ? '::' : ':'
            const [name, ...args] = body.split(separator)
            const callback = state.callbacks.get(normalizeName(name))
            if (!callback) return whole
            const result = callback(body, matcherArg, args, null)
            if (result === null || result === undefined) return whole
            changed = true
            return typeof result === 'string' ? result : result.text
        })
        if (!changed) break
    }
    return rendered
}

function createState(recipe: RevenantPostprocessRecipe, chat: Chat): TemplateState {
    const character = structuredClone(recipe.character)
    character.chats = [chat]
    character.chatPage = 0
    const database = {
        ...structuredClone(recipe.database),
        characters: [character],
        selectedPersona: recipe.database.selectedPersona ?? 0,
    }
    const state: TemplateState = {
        recipe,
        character,
        chat,
        database,
        callbacks: new Map(),
        functions: new Map(),
    }
    const persona = () => selectedPersona(state)
    registerCBS({
        registerFunction: definition => {
            if (definition.callback === 'doc_only') return
            for (const name of [definition.name, ...definition.alias]) {
                state.callbacks.set(normalizeName(name), definition.callback)
            }
        },
        getDatabase: () => state.database as any,
        getUserName: () => persona()?.name ?? recipe.database.username ?? 'User',
        getTriggerId: () => state.triggerId ?? null,
        getPersonaPrompt: () => persona()?.personaPrompt ?? recipe.database.personaPrompt ?? '',
        risuChatParser: text => renderTemplate(text, state),
        makeArray,
        safeStructuredClone: value => structuredClone(value),
        parseArray,
        parseDict,
        getChatVar: key => chatVariable(state, key),
        setChatVar: (key, value) => setChatVariable(state, key, value),
        getGlobalChatVar: key => String(recipe.database.globalChatVariables?.[key] ?? 'null'),
        calcString: calculate,
        dateTimeFormat: formatDate,
        getModules: () => recipe.modules as any[],
        getModuleLorebooks: () => (recipe.modules as any[]).flatMap(module => module?.lorebook ?? []),
        pickHashRand: (seed, hash) => {
            let value = seed >>> 0
            for (let index = 0; index < hash.length; index++) value = Math.imul(value ^ hash.charCodeAt(index), 16777619)
            return (value >>> 0) / 0x100000000
        },
        getSelectedCharID: () => 0,
        getGenerationModelString: () => {
            const name = (recipe.modelPreset as { name?: unknown } | null)?.name
            return typeof name === 'string' ? name : ''
        },
        getGenerationModelMetadata: mode => {
            const rawPreset = mode === 'submodel'
                ? recipe.auxProviders?.submodel?.modelPreset
                : recipe.modelPreset
            const preset = rawPreset as {
                id?: unknown
                name?: unknown
                tokenizerOverride?: unknown
                profileSnapshot?: {
                    adapterKind?: unknown
                    providerBaseId?: unknown
                    modelId?: unknown
                    recommendedTokenizer?: unknown
                }
            } | null
            const stringValue = (value: unknown) => typeof value === 'string' ? value : ''
            const name = stringValue(preset?.name)
            return {
                presetId: stringValue(preset?.id),
                name,
                shortName: name,
                internalId: stringValue(preset?.profileSnapshot?.modelId),
                format: stringValue(preset?.profileSnapshot?.adapterKind),
                provider: stringValue(preset?.profileSnapshot?.providerBaseId),
                tokenizer: (stringValue(preset?.tokenizerOverride)
                    || stringValue(preset?.profileSnapshot?.recommendedTokenizer)
                    || 'tik') as any,
                supportsPrefill: preset?.profileSnapshot?.adapterKind === 'anthropic-messages',
                streaming: false,
                vision: false,
                audioInput: false,
                videoInput: false,
            }
        },
        callInternalFunction: () => '',
        isNodeServer: true,
        isMobile: false,
        appVer: 'revenant-server',
    })
    return state
}

export function renderRevenantTemplate(
    input: string,
    recipe: RevenantPostprocessRecipe,
    chat: Chat = structuredClone(recipe.chat),
): { text: string, chat: Chat } {
    const state = createState(recipe, chat)
    return {
        text: renderTemplate(input, state),
        chat: state.chat,
    }
}

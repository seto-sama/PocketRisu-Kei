import { calculateExpression } from './calculate'

export type TriggerV2Effect = Record<string, unknown> & { type?: string, indent?: number }

type TriggerV2Message = { role?: string, data?: string }

export type TriggerV2CoreAdapter = {
    effects: TriggerV2Effect[]
    render: (value: unknown) => string
    getVar: (key: string) => string
    setVar: (key: string, value: string) => void
    declareLocal: (key: string, value: unknown, indent: number) => void
    clearLocals: (indent: number) => void
    chat?: {
        id?: string
        fmIndex?: number
        note?: string
        message: TriggerV2Message[]
    }
    character?: {
        firstMessage?: string
        alternateGreetings?: string[]
    }
    globalVar?: (key: string) => string
    randomInteger?: (minimum: number, maximum: number, effectIndex: number, visit: number) => number
    onChatMutation?: (field: 'message' | 'note') => void
}

export type TriggerV2CoreStep = {
    handled: boolean
    nextIndex: number
    stop?: boolean
    looped?: boolean
    visit: number
}

function asArray(value: unknown): unknown[] {
    try {
        const parsed = JSON.parse(String(value))
        return Array.isArray(parsed) ? parsed : []
    }
    catch {
        return []
    }
}

function asObject(value: unknown): Record<string, unknown> {
    try {
        const parsed = JSON.parse(String(value))
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {}
    }
    catch {
        return {}
    }
}

function compareValues(left: string, operator: unknown, right: string): boolean {
    switch (operator) {
        case '=':
            return !Number.isNaN(Number(left)) && !Number.isNaN(Number(right))
                ? Number(left) === Number(right)
                : left === right
        case '!=':
            return !Number.isNaN(Number(left)) && !Number.isNaN(Number(right))
                ? Number(left) !== Number(right)
                : left !== right
        case '>': return Number(left) > Number(right)
        case '<': return Number(left) < Number(right)
        case '>=': return Number(left) >= Number(right)
        case '<=': return Number(left) <= Number(right)
        case '∈': return asArray(right).includes(left)
        case '∋': return asArray(left).includes(right)
        case '∉': return !asArray(right).includes(left)
        case '∌': return !asArray(left).includes(right)
        case '≒': {
            const leftNumber = Number(left)
            const rightNumber = Number(right)
            return Number.isNaN(leftNumber) || Number.isNaN(rightNumber)
                ? left.toLocaleLowerCase().replace(/ /g, '') === right.toLocaleLowerCase().replace(/ /g, '')
                : Math.abs(leftNumber - rightNumber) < 0.0001
        }
        case '≡':
            if (right === 'true') return left === 'true' || left === '1'
            if (right === 'false') return !(left === 'true' || left === '1')
            return left === right
        default: return false
    }
}

function defaultRandomInteger(minimum: number, maximum: number): number {
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return 0
    const low = Math.min(Math.trunc(minimum), Math.trunc(maximum))
    const high = Math.max(Math.trunc(minimum), Math.trunc(maximum))
    return Math.floor(Math.random() * (high - low + 1)) + low
}

/**
 * Environment-independent Trigger v2 interpreter.
 *
 * It owns branching, looping, local-variable lifetime, and deterministic data
 * operations. Effects that need an LLM, UI, tokenizer, image generator, or
 * persistent application state are deliberately returned as `handled: false`
 * so the browser and Revenant server can supply their own adapters.
 */
export function createTriggerV2Core(adapter: TriggerV2CoreAdapter) {
    const loopCounts: Record<number, number> = {}
    const visits: Record<number, number> = {}

    const read = (
        effect: TriggerV2Effect,
        field = 'value',
        typeField = `${field}Type`,
    ): string => {
        const rendered = adapter.render(effect[field])
        return effect[typeField] === 'var' ? adapter.getVar(rendered) : rendered
    }
    const outputVar = (effect: TriggerV2Effect): string => (
        adapter.render(effect.outputVar ?? effect.inputVar ?? '')
    )
    const setOutput = (effect: TriggerV2Effect, value: unknown) => {
        adapter.setVar(outputVar(effect), String(value ?? 'null'))
    }

    const step = (index: number): TriggerV2CoreStep => {
        const effect = adapter.effects[index]
        const visit = visits[index] = (visits[index] || 0) + 1
        if (visit > 10_000) throw new Error(`Trigger loop limit exceeded at effect ${index}`)
        if (!effect?.type?.startsWith('v2')) return { handled: false, nextIndex: index, visit }

        const indent = Number.isInteger(effect.indent) && Number(effect.indent) >= 0
            ? Number(effect.indent)
            : 0
        let nextIndex = index
        let looped = false

        switch (effect.type) {
            case 'v2Header':
            case 'v2Comment':
            case 'v2Loop':
            case 'v2LoopNTimes':
                break
            case 'v2SetVar': {
                const key = adapter.render(effect.var)
                const value = read(effect)
                const previousValue = Number(adapter.getVar(key))
                const previous = Number.isNaN(previousValue) ? 0 : previousValue
                const operand = Number(value)
                const result = effect.operator === '+=' ? previous + operand
                    : effect.operator === '-=' ? previous - operand
                        : effect.operator === '*=' ? previous * operand
                            : effect.operator === '/=' ? previous / operand
                                : effect.operator === '%=' ? previous % operand
                                    : value
                adapter.setVar(key, String(result ?? 'null'))
                break
            }
            case 'v2DeclareLocalVar':
                adapter.declareLocal(adapter.render(effect.var), read(effect), indent)
                break
            case 'v2If':
            case 'v2IfAdvanced': {
                const source = effect.type === 'v2If' || effect.sourceType === 'var'
                    ? adapter.getVar(adapter.render(effect.source))
                    : adapter.render(effect.source)
                const target = read(effect, 'target', 'targetType')
                if (!compareValues(String(source), effect.condition, String(target))) {
                    const bodyIndent = indent + 1
                    for (; nextIndex < adapter.effects.length; nextIndex++) {
                        const candidate = adapter.effects[nextIndex]
                        if (candidate?.type !== 'v2EndIndent' || candidate.indent !== bodyIndent) continue
                        const next = adapter.effects[nextIndex + 1]
                        if (next?.type === 'v2Else' && next.indent === indent) nextIndex += 1
                        break
                    }
                }
                break
            }
            case 'v2Else': {
                const bodyIndent = indent + 1
                for (; nextIndex < adapter.effects.length; nextIndex++) {
                    const candidate = adapter.effects[nextIndex]
                    if (candidate?.type === 'v2EndIndent' && candidate.indent === bodyIndent) break
                }
                break
            }
            case 'v2EndIndent': {
                if (effect.endOfLoop) {
                    const loopIndent = indent - 1
                    const endIndex = index
                    for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex--) {
                        const candidate = adapter.effects[candidateIndex]
                        if (!['v2Loop', 'v2LoopNTimes'].includes(candidate?.type || '')
                            || candidate.indent !== loopIndent) continue
                        if (candidate.type === 'v2LoopNTimes') {
                            const limit = Number(read(candidate))
                            loopCounts[candidateIndex] = (loopCounts[candidateIndex] || 0) + 1
                            nextIndex = !Number.isFinite(limit)
                                || loopCounts[candidateIndex] >= Math.max(0, limit)
                                ? endIndex
                                : candidateIndex
                        }
                        else nextIndex = candidateIndex
                        looped = nextIndex === candidateIndex
                        break
                    }
                }
                adapter.clearLocals(indent)
                break
            }
            case 'v2BreakLoop':
                for (; nextIndex < adapter.effects.length; nextIndex++) {
                    const candidate = adapter.effects[nextIndex]
                    if (candidate?.type === 'v2EndIndent' && candidate.endOfLoop) break
                }
                break
            case 'v2StopTrigger':
                return { handled: true, nextIndex: adapter.effects.length, stop: true, visit }
            case 'v2CutChat': {
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                const start = Number(read(effect, 'start', 'startType'))
                const end = Number(read(effect, 'end', 'endType'))
                adapter.chat.message = adapter.chat.message.slice(
                    Number.isNaN(start) ? 0 : start,
                    Number.isNaN(end) ? adapter.chat.message.length : end,
                )
                adapter.onChatMutation?.('message')
                break
            }
            case 'v2ModifyChat': {
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                const message = adapter.chat.message[Number(read(effect, 'index', 'indexType'))]
                if (message) {
                    message.data = read(effect)
                    adapter.onChatMutation?.('message')
                }
                break
            }
            case 'v2Impersonate':
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                adapter.chat.message.push({ role: effect.role === 'user' ? 'user' : 'char', data: read(effect) })
                adapter.onChatMutation?.('message')
                break
            case 'v2ExtractRegex': {
                const match = new RegExp(
                    read(effect, 'regex', 'regexType'),
                    read(effect, 'flags', 'flagsType'),
                ).exec(read(effect))
                setOutput(effect, read(effect, 'result', 'resultType')
                    .replace(/\$([0-9]+)/g, (_whole, matchIndex) => match?.[Number(matchIndex)] || '')
                    .replace(/\$&/g, match?.[0] || '')
                    .replace(/\$\$/g, '$'))
                break
            }
            case 'v2RegexTest': {
                let matched = false
                try {
                    matched = new RegExp(
                        read(effect, 'regex', 'regexType'),
                        read(effect, 'flags', 'flagsType'),
                    ).test(read(effect))
                }
                catch { /* Invalid patterns are false. */ }
                setOutput(effect, matched ? '1' : '0')
                break
            }
            case 'v2ReplaceString': {
                const source = read(effect, 'source', 'sourceType')
                try {
                    const format = read(effect, 'result', 'resultType')
                    const replacement = read(effect, 'replacement', 'replacementType')
                    const regex = new RegExp(
                        read(effect, 'regex', 'regexType'),
                        read(effect, 'flags', 'flagsType'),
                    )
                    setOutput(effect, source.replace(regex, (...args) => {
                        const match = args[0]
                        const groups = args.slice(1, -2)
                        const target = format.match(/^\$(\d+)$/)
                        if (target) {
                            const groupIndex = Number(target[1])
                            if (groupIndex === 0) return replacement
                            if (groups[groupIndex - 1]) return match.replace(groups[groupIndex - 1], replacement)
                        }
                        return format
                            .replace(/\$([0-9]+)/g, (_whole, matchIndex) => (
                                Number(matchIndex) === 0 ? match : groups[Number(matchIndex) - 1] || ''
                            ))
                            .replace(/\$&/g, match)
                            .replace(/\$\$/g, '$')
                    }))
                }
                catch {
                    setOutput(effect, source)
                }
                break
            }
            case 'v2Random': {
                const minimum = Number(read(effect, 'min', 'minType'))
                const maximum = Number(read(effect, 'max', 'maxType'))
                setOutput(effect, (adapter.randomInteger || defaultRandomInteger)(minimum, maximum, index, visit))
                break
            }
            case 'v2GetLastMessage':
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                setOutput(effect, adapter.chat.message.at(-1)?.data ?? 'null')
                break
            case 'v2GetMessageAtIndex':
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                setOutput(effect, adapter.chat.message[Number(read(effect, 'index', 'indexType'))]?.data ?? 'null')
                break
            case 'v2GetMessageCount':
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                setOutput(effect, adapter.chat.message.length)
                break
            case 'v2GetLastUserMessage':
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                setOutput(effect, adapter.chat.message.findLast(message => message.role === 'user')?.data ?? 'null')
                break
            case 'v2GetLastCharMessage':
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                setOutput(effect, adapter.chat.message.findLast(message => message.role === 'char')?.data ?? 'null')
                break
            case 'v2GetFirstMessage':
                if (!adapter.chat || !adapter.character) return { handled: false, nextIndex: index, visit }
                setOutput(effect, (adapter.chat.fmIndex ?? -1) < 0
                    ? adapter.character.firstMessage ?? ''
                    : adapter.character.alternateGreetings?.[adapter.chat.fmIndex!]
                        ?? adapter.character.firstMessage
                        ?? '')
                break
            case 'v2GetCharAt':
                setOutput(effect, read(effect, 'source', 'sourceType')[Number(read(effect, 'index', 'indexType'))] ?? 'null')
                break
            case 'v2GetCharCount':
                setOutput(effect, read(effect, 'source', 'sourceType').length)
                break
            case 'v2ToLowerCase':
                setOutput(effect, read(effect, 'source', 'sourceType').toLocaleLowerCase())
                break
            case 'v2ToUpperCase':
                setOutput(effect, read(effect, 'source', 'sourceType').toLocaleUpperCase())
                break
            case 'v2SetCharAt': {
                const source = [...read(effect, 'source', 'sourceType')]
                source[Number(read(effect, 'index', 'indexType'))] = read(effect)
                setOutput(effect, source.join(''))
                break
            }
            case 'v2ConcatString':
                setOutput(effect, read(effect, 'source1', 'source1Type') + read(effect, 'source2', 'source2Type'))
                break
            case 'v2QuickSearchChat': {
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                const value = read(effect)
                const depth = Number(read(effect, 'depth', 'depthType'))
                const source = adapter.chat.message
                    .slice(Number.isNaN(depth) ? 0 : -Math.max(0, depth))
                    .map(message => message.data || '').join(' ')
                let found = false
                if (effect.condition === 'strict') found = source.split(' ').includes(value)
                else if (effect.condition === 'regex') found = new RegExp(value).test(source)
                else found = source.toLocaleLowerCase().includes(value.toLocaleLowerCase())
                setOutput(effect, found ? '1' : '0')
                break
            }
            case 'v2GetAuthorNote':
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                setOutput(effect, adapter.chat.note ?? '')
                break
            case 'v2SetAuthorNote':
                if (!adapter.chat) return { handled: false, nextIndex: index, visit }
                adapter.chat.note = read(effect)
                adapter.onChatMutation?.('note')
                break
            case 'v2SplitString': {
                const source = read(effect, 'source', 'sourceType')
                const delimiter = read(effect, 'delimiter', 'delimiterType')
                if (effect.delimiterType !== 'regex') {
                    setOutput(effect, JSON.stringify(source.split(delimiter)))
                    break
                }
                try {
                    const literal = delimiter.match(/^\/(.+)\/([gimuy]*)$/)
                    setOutput(effect, JSON.stringify(source.split(literal
                        ? new RegExp(literal[1], literal[2])
                        : new RegExp(delimiter))))
                }
                catch {
                    setOutput(effect, JSON.stringify([source]))
                }
                break
            }
            case 'v2JoinArrayVar':
                setOutput(effect, asArray(read(effect, 'var', 'varType'))
                    .join(read(effect, 'delimiter', 'delimiterType')))
                break
            case 'v2MakeArrayVar': {
                const key = adapter.render(effect.var)
                if (!key.startsWith('[') || !key.endsWith(']')) adapter.setVar(key, '[]')
                break
            }
            case 'v2GetArrayVarLength':
                setOutput(effect, asArray(adapter.getVar(adapter.render(effect.var))).length)
                break
            case 'v2GetArrayVar':
                setOutput(effect, asArray(adapter.getVar(adapter.render(effect.var)))[
                    Number(read(effect, 'index', 'indexType'))
                ] ?? 'null')
                break
            case 'v2SetArrayVar': {
                const key = adapter.render(effect.var)
                const array = asArray(adapter.getVar(key))
                const arrayIndex = Number(read(effect, 'index', 'indexType'))
                if (!Number.isNaN(arrayIndex)) {
                    array[arrayIndex] = read(effect)
                    adapter.setVar(key, JSON.stringify(array))
                }
                break
            }
            case 'v2PushArrayVar': {
                const key = adapter.render(effect.var)
                const array = asArray(adapter.getVar(key))
                array.push(read(effect))
                adapter.setVar(key, JSON.stringify(array))
                break
            }
            case 'v2PopArrayVar': {
                const key = adapter.render(effect.var)
                const array = asArray(adapter.getVar(key))
                setOutput(effect, array.pop() ?? 'null')
                adapter.setVar(key, JSON.stringify(array))
                break
            }
            case 'v2ShiftArrayVar': {
                const key = adapter.render(effect.var)
                const array = asArray(adapter.getVar(key))
                setOutput(effect, array.shift() ?? 'null')
                adapter.setVar(key, JSON.stringify(array))
                break
            }
            case 'v2UnshiftArrayVar': {
                const key = adapter.render(effect.var)
                const array = asArray(adapter.getVar(key))
                array.unshift(read(effect))
                adapter.setVar(key, JSON.stringify(array))
                break
            }
            case 'v2SpliceArrayVar': {
                const key = adapter.render(effect.var)
                const array = asArray(adapter.getVar(key))
                array.splice(Number(read(effect, 'start', 'startType')) || 0, 0, read(effect, 'item', 'itemType'))
                adapter.setVar(key, JSON.stringify(array))
                break
            }
            case 'v2SliceArrayVar':
                setOutput(effect, JSON.stringify(asArray(adapter.getVar(adapter.render(effect.var))).slice(
                    Number(read(effect, 'start', 'startType')) || 0,
                    Number(read(effect, 'end', 'endType')) || 0,
                )))
                break
            case 'v2GetIndexOfValueInArrayVar':
                setOutput(effect, asArray(adapter.getVar(adapter.render(effect.var))).indexOf(read(effect)))
                break
            case 'v2RemoveIndexFromArrayVar': {
                const key = adapter.render(effect.var)
                const array = asArray(adapter.getVar(key))
                array.splice(Number(read(effect, 'index', 'indexType')) || 0, 1)
                adapter.setVar(key, JSON.stringify(array))
                break
            }
            case 'v2MakeDictVar': {
                const key = adapter.render(effect.var)
                if (!key.startsWith('{') || !key.endsWith('}')) adapter.setVar(key, '{}')
                break
            }
            case 'v2GetDictVar':
                setOutput(effect, asObject(read(effect, 'var', 'varType'))[
                    read(effect, 'key', 'keyType')
                ] ?? 'null')
                break
            case 'v2SetDictVar': {
                if (effect.varType === 'value') break
                const key = adapter.render(effect.var)
                const dictionary = asObject(adapter.getVar(key))
                dictionary[read(effect, 'key', 'keyType')] = read(effect)
                adapter.setVar(key, JSON.stringify(dictionary))
                break
            }
            case 'v2DeleteDictKey': {
                if (effect.varType === 'value') break
                const key = adapter.render(effect.var)
                const dictionary = asObject(adapter.getVar(key))
                delete dictionary[read(effect, 'key', 'keyType')]
                adapter.setVar(key, JSON.stringify(dictionary))
                break
            }
            case 'v2HasDictKey':
                setOutput(effect, Object.hasOwn(
                    asObject(read(effect, 'var', 'varType')),
                    read(effect, 'key', 'keyType'),
                ) ? '1' : '0')
                break
            case 'v2ClearDict': {
                const key = adapter.render(effect.var)
                if (!key.startsWith('{') || !key.endsWith('}')) adapter.setVar(key, '{}')
                break
            }
            case 'v2GetDictSize':
                setOutput(effect, Object.keys(asObject(read(effect, 'var', 'varType'))).length)
                break
            case 'v2GetDictKeys':
                setOutput(effect, JSON.stringify(Object.keys(asObject(read(effect, 'var', 'varType')))))
                break
            case 'v2GetDictValues':
                setOutput(effect, JSON.stringify(Object.values(asObject(read(effect, 'var', 'varType')))))
                break
            case 'v2Calculate': {
                const expression = read(effect, 'expression', 'expressionType')
                    .replace(/\$([a-zA-Z0-9_]+)/g, (_whole, key) => {
                        const value = Number.parseFloat(adapter.getVar(key))
                        return Number.isNaN(value) ? '0' : String(value)
                    })
                try {
                    setOutput(effect, calculateExpression(expression, {
                        chat: adapter.getVar,
                        global: adapter.globalVar,
                    }))
                }
                catch {
                    setOutput(effect, '0')
                }
                break
            }
            default:
                return { handled: false, nextIndex: index, visit }
        }

        return { handled: true, nextIndex, looped, visit }
    }

    return { step, read, outputVar }
}

export type TriggerConditionLike = Record<string, unknown> & { type?: string }

export type TriggerConditionContext = {
    conditions: TriggerConditionLike[]
    getVar: (key: string) => string
    render: (value: unknown) => string
    messages: Array<{ data?: string }>
}

function compare(left: string, operator: unknown, right: string): boolean {
    switch (operator) {
        case 'true': return left === 'true' || left === '1'
        case '=': return left === right
        case '!=': return left !== right
        case '>': return Number(left) > Number(right)
        case '<': return Number(left) < Number(right)
        case '>=': return Number(left) >= Number(right)
        case '<=': return Number(left) <= Number(right)
        case 'null': return left === 'null'
        default: return false
    }
}

export function evaluateTriggerConditions(context: TriggerConditionContext): boolean {
    for (const condition of context.conditions) {
        if (condition.type === 'var' || condition.type === 'value' || condition.type === 'chatindex') {
            const rawLeft = condition.type === 'var'
                ? context.getVar(String(condition.var ?? ''))
                : condition.type === 'chatindex'
                    ? String(context.messages.length)
                    : String(condition.var ?? '')
            const left = context.render(rawLeft)
            const right = context.render(condition.value)
            if (!compare(left, condition.operator, right)) return false
            continue
        }
        if (condition.type !== 'exists') continue

        const value = context.render(context.render(condition.value))
        const depth = Math.max(0, Number(condition.depth) || 0)
        // Preserve the browser executor's historical depth=0 behavior: all messages.
        const messages = depth === 0 ? context.messages : context.messages.slice(-depth)
        const source = messages.map(message => message.data ?? '').join(' ')
        if (condition.type2 === 'strict') {
            if (!source.split(' ').includes(value)) return false
        }
        else if (condition.type2 === 'regex') {
            try {
                if (!new RegExp(value).test(source)) return false
            }
            catch {
                return false
            }
        }
        else if (!source.toLocaleLowerCase().includes(value.toLocaleLowerCase())) return false
    }
    return true
}

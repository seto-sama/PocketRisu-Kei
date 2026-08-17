type VariableResolvers = {
    chat?: (key: string) => string
    global?: (key: string) => string
}

const operators = {
    '+': { precedence: 2, associativity: 'Left' },
    '-': { precedence: 2, associativity: 'Left' },
    '*': { precedence: 3, associativity: 'Left' },
    '/': { precedence: 3, associativity: 'Left' },
    '^': { precedence: 4, associativity: 'Left' },
    '%': { precedence: 3, associativity: 'Left' },
    '<': { precedence: 1, associativity: 'Left' },
    '>': { precedence: 1, associativity: 'Left' },
    '|': { precedence: 1, associativity: 'Left' },
    '&': { precedence: 1, associativity: 'Left' },
    '≤': { precedence: 1, associativity: 'Left' },
    '≥': { precedence: 1, associativity: 'Left' },
    '=': { precedence: 1, associativity: 'Left' },
    '≠': { precedence: 1, associativity: 'Left' },
    '!': { precedence: 5, associativity: 'Right' },
} as const

type Operator = keyof typeof operators

function toRPN(expression: string): string {
    let output = ''
    const stack: Operator[] = []
    const operatorKeys = Object.keys(operators) as Operator[]
    const tokens: string[] = []
    let token = ''

    expression = expression.replace(/\s+/g, '')
    for (let index = 0; index < expression.length; index++) {
        const character = expression[index]
        if (
            character === '-'
            && (index === 0
                || operatorKeys.includes(expression[index - 1] as Operator)
                || expression[index - 1] === '(')
        ) {
            token += character
        }
        else if (operatorKeys.includes(character as Operator)) {
            tokens.push(token || '0', character)
            token = ''
        }
        else token += character
    }
    tokens.push(token || '0')

    for (const item of tokens) {
        if (Number.parseFloat(item) || item === '0') output += `${item} `
        else if (operatorKeys.includes(item as Operator)) {
            const operator = item as Operator
            while (
                stack.length > 0
                && (
                    (operators[operator].associativity === 'Left'
                        && operators[operator].precedence <= operators[stack.at(-1)!].precedence)
                    || (operators[operator].associativity === 'Right'
                        && operators[operator].precedence < operators[stack.at(-1)!].precedence)
                )
            ) output += `${stack.pop()} `
            stack.push(operator)
        }
    }
    while (stack.length > 0) output += `${stack.pop()} `
    return output.trim()
}

function evaluateRPN(expression: string): number {
    const stack: number[] = []
    for (const token of expression.split(' ')) {
        if (Number.parseFloat(token) || token === '0') {
            stack.push(Number.parseFloat(token))
            continue
        }
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        switch (token) {
            case '+': stack.push(left + right); break
            case '-': stack.push(left - right); break
            case '*': stack.push(left * right); break
            case '/': stack.push(left / right); break
            case '^': stack.push(left ** right); break
            case '%': stack.push(left % right); break
            case '<': stack.push(left < right ? 1 : 0); break
            case '>': stack.push(left > right ? 1 : 0); break
            case '|': stack.push(left || right); break
            case '&': stack.push(left && right); break
            case '≤': stack.push(left <= right ? 1 : 0); break
            case '≥': stack.push(left >= right ? 1 : 0); break
            case '=': stack.push(left === right ? 1 : 0); break
            case '≠': stack.push(left !== right ? 1 : 0); break
            case '!': stack.push(right ? 0 : 1); break
        }
    }
    return stack.pop() ?? 0
}

function numericVariable(value: string | undefined): string {
    const parsed = Number.parseFloat(value ?? '')
    return Number.isNaN(parsed) ? '0' : String(parsed)
}

function evaluateFlatExpression(text: string, resolvers: VariableResolvers): number {
    const normalized = text
        .replace(/\$([a-zA-Z0-9_]+)/g, (_whole, key: string) => numericVariable(resolvers.chat?.(key)))
        .replace(/@([a-zA-Z0-9_]+)/g, (_whole, key: string) => numericVariable(resolvers.global?.(key)))
        .replace(/&&/g, '&')
        .replace(/\|\|/g, '|')
        .replace(/<=/g, '≤')
        .replace(/>=/g, '≥')
        .replace(/==/g, '=')
        .replace(/!=/g, '≠')
        .replace(/null/gi, '0')
    return evaluateRPN(toRPN(normalized))
}

export function calculateExpression(text: string, resolvers: VariableResolvers = {}): number {
    const levels = ['']
    for (const character of text) {
        if (character === '(') levels.push('')
        else if (character === ')' && levels.length > 1) {
            levels[levels.length - 2] += evaluateFlatExpression(levels.pop()!, resolvers)
        }
        else levels[levels.length - 1] += character
    }
    return evaluateFlatExpression(levels.join(''), resolvers)
}

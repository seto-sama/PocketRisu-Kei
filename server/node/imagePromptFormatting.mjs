const numericWeight = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const weightedContentSuffix = new RegExp(`^([\\s\\S]*)(\\s*:\\s*)(${numericWeight})(\\s*)$`)

function isEscaped(text, index) {
    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
        backslashes += 1
    }
    return backslashes % 2 === 1
}

function unescapeNovelAIParentheses(prompt) {
    let result = ''
    for (let index = 0; index < prompt.length;) {
        if (prompt[index] !== '\\') {
            result += prompt[index]
            index += 1
            continue
        }
        let end = index
        while (prompt[end] === '\\') end += 1
        const backslashes = end - index
        const next = prompt[end]
        if ((next === '(' || next === ')') && backslashes % 2 === 1) {
            result += '\\'.repeat(backslashes - 1) + next
            index = end + 1
        } else {
            result += prompt.slice(index, end)
            index = end
        }
    }
    return result
}

function parseWeightedParenthesisAtStart(prompt, start) {
    let depth = 0
    for (let index = start; index < prompt.length; index += 1) {
        if (prompt[index] === '\\') {
            index += 1
            continue
        }
        if (prompt[index] === '(') {
            depth += 1
            continue
        }
        if (prompt[index] !== ')') continue
        depth -= 1
        if (depth !== 0) continue

        const suffix = prompt.slice(start + 1, index).match(weightedContentSuffix)
        if (!suffix || !suffix[1].trim()) return null
        return {
            end: index + 1,
            content: suffix[1],
            separator: suffix[2],
            weight: suffix[3],
            trailingWhitespace: suffix[4],
        }
    }
    return null
}

function convertNovelAIWeightsToComfy(prompt, animaArtistTagCompatibility = false) {
    let result = ''
    let lastIndex = 0
    const weightPattern = new RegExp(`(${numericWeight})::([\\s\\S]+?)::`, 'g')
    for (const match of prompt.matchAll(weightPattern)) {
        const [value, weight, rawContent] = match
        const start = match.index ?? lastIndex
        result += prompt.slice(lastIndex, start)
        if (rawContent.trim()) {
            const content = rawContent.trim()
            const animaArtist = animaArtistTagCompatibility
                ? content.match(/^artist:\s*(.+)$/)
                : null
            result += animaArtist
                ? `(@${animaArtist[1].trim()}:${weight})`
                : `(${content}:${weight})`
        } else {
            result += value
        }
        lastIndex = start + value.length
    }
    return result + prompt.slice(lastIndex)
}

function escapeComfyParentheses(prompt) {
    let result = ''
    for (let index = 0; index < prompt.length;) {
        const character = prompt[index]
        if (character === '(' && !isEscaped(prompt, index)) {
            const weighted = parseWeightedParenthesisAtStart(prompt, index)
            if (weighted) {
                result += `(${escapeComfyParentheses(weighted.content)}${weighted.separator}${weighted.weight}${weighted.trailingWhitespace})`
                index = weighted.end
                continue
            }
            result += '\\('
        } else if (character === ')' && !isEscaped(prompt, index)) {
            result += '\\)'
        } else {
            result += character
        }
        index += 1
    }
    return result
}

export function formatNovelAIPrompt(prompt, animaArtistTagCompatibility = false) {
    let result = ''
    for (let index = 0; index < prompt.length;) {
        if (prompt[index] === '(' && !isEscaped(prompt, index)) {
            const weighted = parseWeightedParenthesisAtStart(prompt, index)
            if (weighted) {
                const content = weighted.content.trim()
                const weight = weighted.weight
                const animaArtist = animaArtistTagCompatibility
                    ? content.match(/^@\s*(.+)$/)
                    : null
                const naiContent = animaArtist
                    ? `artist:${animaArtist[1].trim()}`
                    : content
                result += `${weight}::${naiContent}::`
                index = weighted.end
                continue
            }
        }
        result += prompt[index]
        index += 1
    }
    return unescapeNovelAIParentheses(result)
}

export function formatComfyUIPrompt(prompt, animaArtistTagCompatibility = false) {
    const formatted = convertNovelAIWeightsToComfy(prompt, animaArtistTagCompatibility)
    return escapeComfyParentheses(formatted)
}

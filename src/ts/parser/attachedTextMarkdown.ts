import type { MarkdownIt, StateCore, Token } from 'markdown-it'

// markdown-it leaves quotes and `*` runs followed directly by text literal
// ('토끼'가, **"兎"**が, "rabbit"s); these rules let them close.

const letterRegex = /\p{L}/u
const cjkRegex = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const isLetter = (code: number) => letterRegex.test(String.fromCodePoint(code))
const isCjk = (code: number) => cjkRegex.test(String.fromCodePoint(code))

function codePointBefore(text: string, index: number) {
    if (index <= 0) return 0x20
    const low = text.charCodeAt(index - 1)
    return low >= 0xDC00 && low <= 0xDFFF && index >= 2 ? text.codePointAt(index - 2)! : low
}

const ASTERISK = 0x2A
const QUOTE_TEST_RE = /['"]/
const QUOTE_RE = /['"]/g
const APOSTROPHE = '’'
const MAX_OPENERS = 1000

type QuoteOpener = {
    tokenIdx: number
    contentPos: number
    isSingleQuote: boolean
    level: number
    prevSameQuoteIdx: number
}
type Replacements = Record<number, { pos: number, ch: string }[]>

export function allowAttachedText(md: MarkdownIt): void {
    const { isMdAsciiPunct, isPunctCharCode, isWhiteSpace } = md.utils
    const isPunct = (code: number) => isMdAsciiPunct(code) || isPunctCharCode(code)

    md.inline.State = class extends md.inline.State {
        scanDelims(start: number, canSplitWord: boolean) {
            const scanned = super.scanDelims(start, canSplitWord)
            if (this.src.charCodeAt(start) !== ASTERISK || (scanned.can_open && scanned.can_close)) return scanned
            const before = codePointBefore(this.src, start)
            const end = start + scanned.length
            const after = end < this.posMax ? this.src.codePointAt(end)! : 0x20
            if (!scanned.can_close && isPunct(before) && isLetter(after)) scanned.can_close = true
            if (!scanned.can_open && isPunct(after) && isLetter(before)) scanned.can_open = true
            return scanned
        }
    }

    // markdown-it 15 smartquotes (MIT); only the quote-between-letters case differs.
    const truncateStack = (stack: QuoteOpener[], heads: { single: number, double: number }, length: number) => {
        while (stack.length > length) {
            const item = stack.pop()!
            if (item.isSingleQuote) heads.single = item.prevSameQuoteIdx
            else heads.double = item.prevSameQuoteIdx
        }
    }
    const addReplacement = (replacements: Replacements, tokenIdx: number, pos: number, ch: string) => {
        (replacements[tokenIdx] ??= []).push({ pos, ch })
    }
    const applyReplacements = (str: string, replacements: Replacements[number]) => {
        let result = ''
        let lastPos = 0
        replacements.sort((a, b) => a.pos - b.pos)
        for (const replacement of replacements) {
            result += str.slice(lastPos, replacement.pos) + replacement.ch
            lastPos = replacement.pos + 1
        }
        return result + str.slice(lastPos)
    }

    const processInlines = (tokens: Token[], state: StateCore) => {
        const stack: QuoteOpener[] = []
        const heads = { single: -1, double: -1 }
        const replacements: Replacements = {}
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]
            const thisLevel = token.level
            let j: number
            for (j = stack.length - 1; j >= 0; j--) if (stack[j].level <= thisLevel) break
            truncateStack(stack, heads, j + 1)
            if (token.type !== 'text') continue
            const text = token.content
            let pos = 0
            const max = text.length
            OUTER: while (pos < max) {
                QUOTE_RE.lastIndex = pos
                const t = QUOTE_RE.exec(text)
                if (!t) break
                let canOpen = true
                let canClose = true
                pos = t.index + 1
                const isSingle = t[0] === "'"
                let lastChar = 0x20
                if (t.index - 1 >= 0) lastChar = text.charCodeAt(t.index - 1)
                else for (j = i - 1; j >= 0; j--) {
                    if (tokens[j].type === 'softbreak' || tokens[j].type === 'hardbreak') break
                    if (!tokens[j].content) continue
                    lastChar = tokens[j].content.charCodeAt(tokens[j].content.length - 1)
                    break
                }
                let nextChar = 0x20
                if (pos < max) nextChar = text.charCodeAt(pos)
                else for (j = i + 1; j < tokens.length; j++) {
                    if (tokens[j].type === 'softbreak' || tokens[j].type === 'hardbreak') break
                    if (!tokens[j].content) continue
                    nextChar = tokens[j].content.charCodeAt(0)
                    break
                }
                const isLastPunctChar = isPunct(lastChar)
                const isNextPunctChar = isPunct(nextChar)
                const isLastWhiteSpace = isWhiteSpace(lastChar)
                const isNextWhiteSpace = isWhiteSpace(nextChar)
                if (isNextWhiteSpace) canOpen = false
                else if (isNextPunctChar && !(isLastWhiteSpace || isLastPunctChar)) canOpen = false
                if (isLastWhiteSpace) canClose = false
                else if (isLastPunctChar && !(isNextWhiteSpace || isNextPunctChar)) canClose = false
                if (nextChar === 0x22 && t[0] === '"' && lastChar >= 0x30 && lastChar <= 0x39) {
                    canClose = canOpen = false
                }
                if (canOpen && canClose) {
                    if (attachesToText(isSingle, lastChar, nextChar)) {
                        const head = isSingle ? heads.single : heads.double
                        canClose = head >= 0 && stack[head].level === thisLevel
                        canOpen = !canClose
                    } else {
                        canOpen = isLastPunctChar
                        canClose = isNextPunctChar
                    }
                }
                if (!canOpen && !canClose) {
                    if (isSingle) addReplacement(replacements, i, t.index, APOSTROPHE)
                    continue
                }
                if (canClose) {
                    j = isSingle ? heads.single : heads.double
                    if (j >= 0 && stack[j].level === thisLevel) {
                        const item = stack[j]
                        const quotes = state.md.options.quotes
                        const [openQuote, closeQuote] = isSingle ? [quotes[2], quotes[3]] : [quotes[0], quotes[1]]
                        addReplacement(replacements, i, t.index, closeQuote)
                        addReplacement(replacements, item.tokenIdx, item.contentPos, openQuote)
                        truncateStack(stack, heads, j)
                        continue OUTER
                    }
                }
                if (canOpen) {
                    if (stack.length >= MAX_OPENERS) return
                    stack.push({
                        tokenIdx: i,
                        contentPos: t.index,
                        isSingleQuote: isSingle,
                        level: thisLevel,
                        prevSameQuoteIdx: isSingle ? heads.single : heads.double,
                    })
                    if (isSingle) heads.single = stack.length - 1
                    else heads.double = stack.length - 1
                } else if (canClose && isSingle) addReplacement(replacements, i, t.index, APOSTROPHE)
            }
        }
        for (const tokenIdx of Object.keys(replacements)) {
            const idx = Number(tokenIdx)
            tokens[idx].content = applyReplacements(tokens[idx].content, replacements[idx])
        }
    }

    md.core.ruler.at('smartquotes', (state) => {
        if (!state.md.options.typographer) return
        for (let blkIdx = state.tokens.length - 1; blkIdx >= 0; blkIdx--) {
            const token = state.tokens[blkIdx]
            if (token.type !== 'inline' || !QUOTE_TEST_RE.test(token.content)) continue
            processInlines(token.children!, state)
        }
    })
}

// Single quotes between Latin letters stay apostrophes (don't, rabbit's).
function attachesToText(isSingle: boolean, lastChar: number, nextChar: number) {
    if (!isLetter(lastChar) || !isLetter(nextChar)) return false
    return !isSingle || isCjk(lastChar) || isCjk(nextChar)
}

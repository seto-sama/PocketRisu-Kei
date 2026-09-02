import { extractThinkTags } from '../preset/thinkingTags'

const LETTER_PATTERN = /\p{Letter}/u
const HANGUL_PATTERN = /\p{Script=Hangul}/u
const HAN_PATTERN = /\p{Script=Han}/u
const LATIN_PATTERN = /\p{Script=Latin}/u
const NON_LANGUAGE_CONTENT_SELECTOR = [
    '.x-risu-thoughts',
    '.x-risu-streaming-thoughts',
    'thoughts',
    'think',
    'img',
    'picture',
    'script',
    'style',
    'noscript',
    'template',
].join(',')

function getUiLanguageScriptPattern(language: string): RegExp {
    if (language === 'ko') return HANGUL_PATTERN
    if (language === 'cn' || language === 'zh-Hant' || language.startsWith('zh')) return HAN_PATTERN
    return LATIN_PATTERN
}

function stripDisplayedThoughts(source: string): string {
    // Risu persists displayed reasoning in <Thoughts>. Provider-native
    // <think> blocks use the shared preset helper.
    const withoutDisplayedThoughts = source.replace(
        /<Thoughts>[\s\S]*?(?:<\/Thoughts>|$)/giu,
        '',
    )
    return extractThinkTags(withoutDisplayedThoughts).text
}

function stripCBSTokens(source: string): string {
    const visibleChunks: string[] = []
    let depth = 0
    let index = 0
    let visibleStart = 0

    while (index < source.length) {
        if (source.startsWith('{{', index)) {
            if (depth === 0) visibleChunks.push(source.slice(visibleStart, index))
            depth += 1
            index += 2
            continue
        }
        if (depth > 0 && source.startsWith('}}', index)) {
            depth -= 1
            index += 2
            if (depth === 0) visibleStart = index
            continue
        }
        index += 1
    }

    if (depth === 0) visibleChunks.push(source.slice(visibleStart))
    return visibleChunks.join('')
}

/**
 * Compares the dominant Unicode script in a message with the UI language.
 * Chain-of-thought and CBS tokens are removed first. Common characters
 * (digits, punctuation, emoji and markdown delimiters) are ignored. This
 * intentionally detects script rather than making an unreliable guess between
 * languages that share Latin characters.
 */
export function isTextLikelyDifferentFromUiLanguage(text: string, uiLanguage: string): boolean {
    const visibleText = stripCBSTokens(stripDisplayedThoughts(text))
    const uiScriptPattern = getUiLanguageScriptPattern(uiLanguage)
    let uiScriptLetters = 0
    let otherScriptLetters = 0

    for (const character of visibleText) {
        if (!LETTER_PATTERN.test(character)) continue
        if (uiScriptPattern.test(character)) uiScriptLetters += 1
        else otherScriptLetters += 1
    }

    return otherScriptLetters > uiScriptLetters
}

/**
 * Extracts the text a user can actually read from fully rendered chat HTML.
 * Media metadata and chain-of-thought containers must not influence language
 * detection even though they can contain a large amount of foreign text.
 */
export function getRenderedTextForLanguageDetection(html: string): string {
    const withoutRawThoughts = stripDisplayedThoughts(html)
    if (typeof DOMParser === 'undefined') {
        return withoutRawThoughts.replace(/<[^>]*>/gu, ' ')
    }

    const document = new DOMParser().parseFromString(withoutRawThoughts, 'text/html')
    document.querySelectorAll(NON_LANGUAGE_CONTENT_SELECTOR).forEach(element => element.remove())
    return document.body.textContent ?? ''
}

export function isRenderedTextLikelyDifferentFromUiLanguage(
    html: string,
    uiLanguage: string,
): boolean {
    return isTextLikelyDifferentFromUiLanguage(
        getRenderedTextForLanguageDetection(html),
        uiLanguage,
    )
}

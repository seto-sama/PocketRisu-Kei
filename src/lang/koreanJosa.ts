export type KoreanJosaPair = '은/는' | '이/가' | '을/를' | '으로/로'

type FinalSound = 'none' | 'rieul' | 'other'

const josaByFinalSound: Record<KoreanJosaPair, Record<FinalSound, string>> = {
    '은/는': { none: '는', rieul: '은', other: '은' },
    '이/가': { none: '가', rieul: '이', other: '이' },
    '을/를': { none: '를', rieul: '을', other: '을' },
    '으로/로': { none: '로', rieul: '로', other: '으로' },
}

const digitFinalSounds: Record<string, FinalSound> = {
    '0': 'other', // 영
    '1': 'rieul', // 일
    '2': 'none',  // 이
    '3': 'other', // 삼
    '4': 'none',  // 사
    '5': 'none',  // 오
    '6': 'other', // 육
    '7': 'rieul', // 칠
    '8': 'rieul', // 팔
    '9': 'none',  // 구
}

function inferLatinFinalSound(word: string): FinalSound {
    // Initialisms are normally read as letter names in Korean (GPT -> 지피티).
    if (word.length > 1 && word === word.toUpperCase()) {
        const last = word.at(-1) ?? ''
        if (last === 'L' || last === 'R') return 'rieul'
        if (last === 'M' || last === 'N') return 'other'
        return 'none'
    }

    const lower = word.toLowerCase()

    // A few common name endings improve the guess without needing a dictionary.
    if (/(?:ie|ee|oe)$/.test(lower)) return 'none'
    if (/le$/.test(lower)) return 'rieul'
    if (/(?:me|ne)$/.test(lower)) return 'other'

    const last = lower.at(-1) ?? ''
    if ('aeiouy'.includes(last)) return 'none'
    if (last === 'l' || last === 'r') return 'rieul'

    // These endings are commonly represented as a Korean final consonant.
    if ('mnbpkgcq'.includes(last)) return 'other'

    // Other English consonants commonly gain a trailing vowel when transliterated.
    return 'none'
}

function inferFinalSound(value: string): FinalSound {
    const normalized = value.normalize('NFC')
    const characters = Array.from(normalized)

    for (let index = characters.length - 1; index >= 0; index--) {
        const character = characters[index]

        // Ignore punctuation, combining marks, and the Japanese long-vowel mark.
        if (character === 'ー' || !/[\p{L}\p{N}]/u.test(character)) continue

        const codePoint = character.codePointAt(0) ?? 0

        // Precomposed Hangul syllables: the remainder is the jongseong index.
        if (codePoint >= 0xac00 && codePoint <= 0xd7a3) {
            const jongseong = (codePoint - 0xac00) % 28
            if (jongseong === 0) return 'none'
            if (jongseong === 8) return 'rieul'
            return 'other'
        }

        // Standalone Hangul consonants and jongseong jamo.
        if (character === 'ㄹ' || codePoint === 0x11af) return 'rieul'
        if (
            /[ㄱ-ㅎ]/u.test(character)
            || (codePoint >= 0x11a8 && codePoint <= 0x11ff)
        ) return 'other'

        if (digitFinalSounds[character]) return digitFinalSounds[character]

        if (/[A-Za-z]/.test(character)) {
            const textThroughCharacter = characters.slice(0, index + 1).join('')
            const latinWord = textThroughCharacter.match(/[A-Za-z]+$/)?.[0] ?? character
            return inferLatinFinalSound(latinWord)
        }

        // Japanese kana are open syllables except ん/ン and a trailing small っ/ッ.
        if (character === 'ん' || character === 'ン' || character === 'っ' || character === 'ッ') {
            return 'other'
        }
        if (/[぀-ヿ]/u.test(character)) return 'none'

        // Pronunciation cannot be inferred from a final kanji or another script.
        return 'none'
    }

    return 'none'
}

export function getKoreanJosa(value: string, pair: KoreanJosaPair): string {
    return josaByFinalSound[pair][inferFinalSound(value)]
}

export function appendKoreanJosa(value: string, pair: KoreanJosaPair): string {
    return `${value}${getKoreanJosa(value, pair)}`
}

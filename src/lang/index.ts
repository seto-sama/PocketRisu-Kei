import { languageChinese } from "./cn";
import { languageGerman } from "./de";
import { languageEnglish } from "./en";
import { languageKorean } from "./ko";
import { languageVietnamese } from "./vi";
import { languageChineseTraditional } from "./zh-Hant";
import { languageSpanish } from "./es";

export let language:typeof languageEnglish = languageEnglish

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

/** Fill missing translation entries from English while replacing leaf values whole. */
export function mergeLanguage<T extends Record<string, unknown>>(
    fallback: T,
    translation: DeepPartial<T>,
): T {
    const mergeObject = (
        base: Record<string, unknown>,
        override: Record<string, unknown>,
    ): Record<string, unknown> => {
        const result = { ...base }
        for (const [key, value] of Object.entries(override)) {
            if (value === undefined) continue
            result[key] = isPlainObject(base[key]) && isPlainObject(value)
                ? mergeObject(base[key], value)
                : value
        }
        return result
    }

    return mergeObject(
        fallback,
        translation as Record<string, unknown>,
    ) as T
}


export function changeLanguage(lang:string){
    if(lang === 'cn'){
        language = mergeLanguage(languageEnglish, languageChinese)
    }
    else if(lang === 'de'){
        language = mergeLanguage(languageEnglish, languageGerman)
    }
    else if(lang === 'ko'){
        language = mergeLanguage(languageEnglish, languageKorean)
    }
    else if(lang === 'vi'){
        language = mergeLanguage(languageEnglish, languageVietnamese)
    }
    else if(lang === 'zh-Hant'){
        language = mergeLanguage(languageEnglish, languageChineseTraditional)
    }
    else if(lang === 'es'){
        language = mergeLanguage(languageEnglish, languageSpanish)
    }
    else{
        language = languageEnglish
    }
    try { localStorage.setItem('risu-lang', lang) } catch {}
}

// BCP 47 locale for Intl APIs. Risu uses its own short codes internally
// (e.g. 'cn'/'zh-Hant') which are not valid IETF tags, so map to canonical
// forms when passing to Intl.RelativeTimeFormat / Intl.DateTimeFormat.
const LOCALE_MAP: Record<string, string> = {
    en: 'en',
    ko: 'ko',
    cn: 'zh-CN',
    'zh-Hant': 'zh-TW',
    de: 'de',
    vi: 'vi',
    es: 'es',
}

export function getCurrentLocale(): string {
    let cached: string | null = null
    try { cached = localStorage.getItem('risu-lang') } catch {}
    if (cached && LOCALE_MAP[cached]) return LOCALE_MAP[cached]
    return (typeof navigator !== 'undefined' && navigator.language) || 'en'
}

/**
 * Apply cached language before DB is loaded.
 * This allows pre-auth UI (e.g. password prompt) to appear in the user's language.
 */
export function applyEarlyLanguage(){
    try {
        const cached = localStorage.getItem('risu-lang')
        if(cached) changeLanguage(cached)
    } catch {}
}

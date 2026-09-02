export const TRANSLATOR_ENGINE_OPTIONS = [
    { value: 'llm', label: 'Ax. Model' },
    { value: 'google', label: 'Google' },
    { value: 'bergamot', label: 'Firefox' },
] as const

export const SUPPORTED_TRANSLATOR_TYPES = [
    ...TRANSLATOR_ENGINE_OPTIONS.map(option => option.value),
    'none',
] as const

export type TranslatorType = typeof SUPPORTED_TRANSLATOR_TYPES[number]

const supportedTranslatorTypes = new Set<string>(SUPPORTED_TRANSLATOR_TYPES)

export function isSupportedTranslatorType(value: unknown): value is TranslatorType {
    return typeof value === 'string' && supportedTranslatorTypes.has(value)
}

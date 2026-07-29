// Locale-aware text picker for registry-defined strings.
// Reads DBState.db.language and falls back to the base English string.
// Used by SchemaFormRenderer/SchemaFieldRenderer + ModelProfileBrowser.

import { DBState } from 'src/ts/stores.svelte'
import { language } from 'src/lang'

export type RegistryLocale = 'ko' | 'en'

export function pickRegistryLocale(): RegistryLocale {
    return DBState.db?.language === 'ko' ? 'ko' : 'en'
}

export function localizeRegistryText(
    base: string | undefined,
    i18n: Record<string, string> | undefined,
    locale: RegistryLocale = pickRegistryLocale(),
): string {
    return i18n?.[locale] ?? base ?? ''
}

export function localizeDisplayName(
    item: { displayName: string; displayNameI18n?: Record<string, string> },
    locale: RegistryLocale = pickRegistryLocale(),
): string {
    return item.displayNameI18n?.[locale] ?? item.displayName
}

export function localizeDescription(
    item: { description?: string; descriptionI18n?: Record<string, string>; helpKey?: string },
    locale: RegistryLocale = pickRegistryLocale(),
): string {
    const keyed = languageString(language.help, item.helpKey)
    if (keyed !== undefined) return keyed
    return item.descriptionI18n?.[locale] ?? item.description ?? ''
}

export function localizeGroupLabel(
    group: { label: string; labelKey?: string; labelI18n?: Record<string, string> },
    locale: RegistryLocale = pickRegistryLocale(),
): string {
    const keyed = languageString(language, group.labelKey)
    if (keyed !== undefined) return keyed
    return group.labelI18n?.[locale] ?? group.label
}

export function localizeFieldLabel(
    field: { label: string; labelKey?: string; labelI18n?: Record<string, string> },
    locale: RegistryLocale = pickRegistryLocale(),
): string {
    return languageString(language, field.labelKey)
        ?? field.labelI18n?.[locale]
        ?? field.label
}

function languageString(source: object, key?: string): string | undefined {
    if (!key) return undefined
    const value = (source as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : undefined
}

import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../storage/database.svelte'
import { languageSettingsItems } from './languageSettingsData.svelte'

vi.mock('src/lang', () => ({
    changeLanguage: () => {},
    language: {},
}))
vi.mock('../util', () => ({ sleep: async () => {} }))
vi.mock('../alert', () => ({
    alertNormal: () => {},
    alertSelect: async () => '-1',
}))
vi.mock('../globalApi.svelte', () => ({ downloadFile: () => {} }))

function setting(id: string) {
    const item = languageSettingsItems.find(candidate => candidate.id === id)
    if (!item) throw new Error(`Missing setting: ${id}`)
    return item
}

function context(translatorType: Database['translatorType'], htmlTranslation = false) {
    return {
        db: {
            translator: 'ko',
            translatorType,
            htmlTranslation,
        } as Database,
    }
}

describe('translation settings', () => {
    it('only offers supported translator engines', () => {
        const values = setting('lang.translatorType').options?.selectOptions
            ?.map(option => option.value)

        expect(values).toEqual(['llm', 'google', 'bergamot'])
    })

    it('does not show combine translation for Ax. Model or HTML-aware Firefox', () => {
        const condition = setting('lang.combineTranslation').condition

        expect(condition?.(context('llm'))).toBe(false)
        expect(condition?.(context('google'))).toBe(true)
        expect(condition?.(context('bergamot', false))).toBe(true)
        expect(condition?.(context('bergamot', true))).toBe(false)
    })
})

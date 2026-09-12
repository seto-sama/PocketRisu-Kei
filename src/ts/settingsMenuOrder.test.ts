import { describe, expect, it } from 'vitest'
import {
    DEFAULT_SETTINGS_MENU_ORDER,
    normalizeSettingsMenuOrder,
    settingsMenuKey,
    SETTINGS_MENU_LANGUAGE,
    SETTINGS_MENU_SEARCH,
} from './settingsMenuOrder'

describe('settings menu ordering', () => {
    it('places settings search first by default', () => {
        expect(normalizeSettingsMenuOrder(undefined)).toEqual(DEFAULT_SETTINGS_MENU_ORDER)
        expect(DEFAULT_SETTINGS_MENU_ORDER[0]).toBe(SETTINGS_MENU_SEARCH)
        expect(settingsMenuKey(16)).toBe('core:16')
    })

    it('keeps a saved order and appends newly introduced items', () => {
        const saved = [SETTINGS_MENU_LANGUAGE, SETTINGS_MENU_SEARCH]
        expect(normalizeSettingsMenuOrder(saved).slice(0, 2)).toEqual(saved)
        expect(normalizeSettingsMenuOrder(saved)).toHaveLength(DEFAULT_SETTINGS_MENU_ORDER.length)
    })
})

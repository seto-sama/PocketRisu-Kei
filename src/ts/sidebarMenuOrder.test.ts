import { describe, expect, it } from 'vitest'
import {
    DEFAULT_SIDEBAR_MENU_ORDER,
    SIDEBAR_MENU_CHARACTERS,
    SIDEBAR_MENU_HOME,
    SIDEBAR_MENU_SETTINGS,
    appendNewPluginMenuItems,
    dividerSidebarMenuKey,
    getVisibleSidebarMenuOrder,
    mergeVisibleSidebarMenuOrder,
    normalizeSidebarMenuOrder,
    pluginSidebarMenuKey,
} from './sidebarMenuOrder'

describe('sidebar menu ordering', () => {
    it('defaults to home, characters, settings with a plugin divider', () => {
        expect(normalizeSidebarMenuOrder(undefined)).toEqual(DEFAULT_SIDEBAR_MENU_ORDER)
        expect(DEFAULT_SIDEBAR_MENU_ORDER.slice(0, 3)).toEqual([
            SIDEBAR_MENU_HOME,
            SIDEBAR_MENU_CHARACTERS,
            SIDEBAR_MENU_SETTINGS,
        ])
    })

    it('always appends newly discovered plugins', () => {
        const customOrder = [SIDEBAR_MENU_SETTINGS, SIDEBAR_MENU_HOME, SIDEBAR_MENU_CHARACTERS]
        expect(appendNewPluginMenuItems(customOrder, [pluginSidebarMenuKey('alpha'), pluginSidebarMenuKey('beta')])).toEqual([
            ...customOrder,
            pluginSidebarMenuKey('alpha'),
            pluginSidebarMenuKey('beta'),
        ])
    })

    it('hides unloaded plugins without forgetting their saved positions', () => {
        const alpha = pluginSidebarMenuKey('alpha')
        const beta = pluginSidebarMenuKey('beta')
        const stored = [SIDEBAR_MENU_HOME, alpha, SIDEBAR_MENU_CHARACTERS, beta, SIDEBAR_MENU_SETTINGS]
        expect(getVisibleSidebarMenuOrder(stored, [beta], false)).toEqual([
            SIDEBAR_MENU_HOME,
            SIDEBAR_MENU_CHARACTERS,
            beta,
            SIDEBAR_MENU_SETTINGS,
        ])
        expect(mergeVisibleSidebarMenuOrder(stored, [SIDEBAR_MENU_SETTINGS, SIDEBAR_MENU_HOME, beta, SIDEBAR_MENU_CHARACTERS])).toEqual([
            SIDEBAR_MENU_SETTINGS,
            alpha,
            SIDEBAR_MENU_HOME,
            beta,
            SIDEBAR_MENU_CHARACTERS,
        ])
    })

    it('shows edge dividers only while editing', () => {
        const divider = dividerSidebarMenuKey('custom')
        const stored = [SIDEBAR_MENU_HOME, SIDEBAR_MENU_SETTINGS, divider]
        expect(getVisibleSidebarMenuOrder(stored, [], false)).toEqual([
            SIDEBAR_MENU_HOME,
            SIDEBAR_MENU_SETTINGS,
        ])
        expect(getVisibleSidebarMenuOrder(stored, [], true)).toEqual(stored)
    })

    it('shows hidden icons only while editing', () => {
        const stored = [SIDEBAR_MENU_HOME, SIDEBAR_MENU_CHARACTERS, SIDEBAR_MENU_SETTINGS]
        expect(getVisibleSidebarMenuOrder(stored, [], false, [SIDEBAR_MENU_CHARACTERS])).toEqual([
            SIDEBAR_MENU_HOME,
            SIDEBAR_MENU_SETTINGS,
        ])
        expect(getVisibleSidebarMenuOrder(stored, [], true, [SIDEBAR_MENU_CHARACTERS])).toEqual(stored)
    })
})
